import http from "node:http";
import { Admission, EvidenceStore, sameSecret, runId, artifactName } from "./public-limits.ts";
import { runContainer } from "./container-runner.ts";
import { parseTarget, resolvePublicHost } from "./network-policy.ts";
import { parseFeatureCheck } from "./explore.ts";
import { TraceError } from "./errors.ts";

export function createGateway(secret: string, runner: typeof runContainer = runContainer) {
  if (secret.length < 32) throw new Error("Gateway key is too short");
  const admission = new Admission();
  const evidence = new EvidenceStore();
  let active: AbortController | undefined;
  const prune = setInterval(() => evidence.prune(), 60_000);
  prune.unref();

  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body));
    };
    if (request.headers.origin || !sameSecret(request.headers.authorization ?? "", `Bearer ${secret}`)) {
      json(403, { error: "Access denied." }); return;
    }
    try {
      const pathname = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
      if (request.method === "POST" && pathname === "/captures") {
        if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new TraceError("Use application/json.", 415);
        const release = admission.acquire();
        const controller = new AbortController();
        active = controller;
        const timeout = setTimeout(() => controller.abort(), 100_000);
        const cancel = () => { if (!response.writableEnded) controller.abort(); };
        response.once("close", cancel);
        try {
          let body = "";
          for await (const chunk of request) {
            body += chunk;
            if (Buffer.byteLength(body) > 4096) throw new TraceError("Request too large.", 413);
          }
          let input;
          try { input = JSON.parse(body); } catch { throw new TraceError("Invalid JSON.", 400); }
          const target = parseTarget(input?.url);
          await resolvePublicHost(target.hostname);
          const url = target.href;
          const featureCheck = parseFeatureCheck(input?.featureCheck);
          const bundle = await runner({ url, featureCheck }, controller.signal, () => admission.disable());
          const saved = evidence.save(bundle);
          if (!response.destroyed) json(201, saved);
        } finally {
          clearTimeout(timeout); response.removeListener("close", cancel); active = undefined; release();
        }
        return;
      }
      const parts = pathname.split("/");
      if (request.method === "GET" && parts.length === 4 && parts[1] === "runs" && runId.test(parts[2]!) && artifactName.test(parts[3]!)) {
        const contents = evidence.get(parts[2]!, parts[3]!, String(request.headers["x-trace-access"] ?? ""));
        if (!contents) { json(404, { error: "Evidence is unavailable or expired." }); return; }
        const name = parts[3]!;
        response.setHeader("Content-Type", name.endsWith(".png") ? "image/png" : name.endsWith(".zip") ? "application/zip" : "application/json");
        if (!name.endsWith(".png")) response.setHeader("Content-Disposition", `attachment; filename="${name}"`);
        response.end(contents); return;
      }
      json(404, { error: "Not found." });
    } catch (error) {
      if (!response.destroyed) json(error instanceof TraceError ? error.status : 500, {
        error: error instanceof TraceError ? error.message : "The investigation could not complete.",
      });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxConnections = 32;
  server.once("close", () => clearInterval(prune));
  return { server, abort: () => active?.abort() };
}
