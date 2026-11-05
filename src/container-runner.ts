import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { TraceError } from "./errors.ts";

const dockerHost = "unix:///var/run/docker.sock";

async function dockerCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["--host", dockerHost, ...args], { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH } });
    let output = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Docker control timed out")); }, 10_000);
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 64 * 1024) child.kill("SIGKILL"); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); code === 0 ? resolve(output) : reject(new Error("Docker control failed")); });
  });
}

export async function verifyIsolation() {
  const network = JSON.parse(await dockerCommand(["network", "inspect", "trace-isolated"]));
  if (network[0]?.Internal !== true || network[0]?.IPAM?.Config?.[0]?.Subnet !== "172.30.0.0/24") throw new Error("The isolated network is missing or unsafe");
  const containers = Object.values(network[0].Containers ?? {}) as { Name: string }[];
  if (containers.length !== 1 || containers[0]?.Name !== "trace-egress") throw new Error("The isolated network must contain only Trace's proxy before startup");
  const [proxy] = JSON.parse(await dockerCommand(["container", "inspect", "trace-egress"]));
  const image = (await dockerCommand(["image", "inspect", "trace-worker:local", "--format", "{{.Id}}"])).trim();
  const host = proxy?.HostConfig;
  if (proxy?.Image !== image || proxy?.State?.Running !== true || proxy?.Config?.User !== "pwuser" || host?.ReadonlyRootfs !== true || host?.Privileged || !host?.CapDrop?.includes("ALL") || !host?.SecurityOpt?.includes("no-new-privileges:true") || proxy.Mounts?.length || Object.keys(host.PortBindings ?? {}).length) {
    throw new Error("The egress proxy does not match the isolated configuration");
  }
}

export async function runContainer(input: unknown, signal: AbortSignal, cleanupFailed: () => void, command = ["node", "dist/src/isolated-worker.js"]): Promise<unknown> {
  if (signal.aborted) throw new TraceError("The investigation was cancelled.", 504);
  const name = `trace-job-${randomUUID()}`;
  const args = ["create", "--pull=never", "--name", name, "--init", "--interactive", "--log-driver", "none",
    "--network", "trace-isolated", "--user", "pwuser", "--cap-drop", "ALL", "--read-only",
    "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${path.resolve("deployment/seccomp.json")}`,
    "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--pids-limit", "256", "--shm-size", "256m",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m,mode=1777", "--env", "HOME=/tmp", "trace-worker:local", ...command];
  try {
    await dockerCommand(args);
  } catch {
    // A timed-out create has an uncertain daemon-side outcome; don't admit more work.
    cleanupFailed();
    await dockerCommand(["container", "rm", "--force", name]).catch(() => {});
    throw new TraceError("The isolated worker could not be created. Investigations have been disabled.", 503);
  }
  const child = spawn("docker", ["--host", dockerHost, "start", "--attach", "--interactive", name], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH } });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let bytes = 0;
  const chunks: Buffer[] = [];
  const abort = () => { child.kill("SIGKILL"); };
  signal.addEventListener("abort", abort, { once: true });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(input));
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 34 * 1024 * 1024) {
          abort(); reject(new TraceError("The investigation exceeded its evidence limit.", 422));
        } else chunks.push(chunk);
      });
      child.once("error", () => reject(new TraceError("The isolated worker is unavailable.", 503)));
      child.once("close", (code) => {
        if (signal.aborted) return reject(new TraceError("The investigation exceeded its time limit or was cancelled.", 504));
        if (code !== 0) return reject(new TraceError("The isolated investigation could not complete.", 422));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("Invalid worker response")); }
      });
      if (signal.aborted) abort();
    });
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    child.kill("SIGKILL");
    await closed;
    // Killing the Docker client alone does not stop its container. Confirm removal.
    try {
      await dockerCommand(["container", "rm", "--force", name]).catch(() => {});
      const remaining = await dockerCommand(["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
      if (remaining.trim()) throw new Error("Worker still exists");
    } catch {
      cleanupFailed();
      throw new TraceError("Worker cleanup could not be verified. Investigations have been disabled.", 503);
    }
  }
}
