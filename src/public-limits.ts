import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import type { CaptureReport } from "./capture.ts";
import { TraceError } from "./errors.ts";

export const artifactName = /^(screenshot\.png|mobile\.png|report\.json|(?:desktop|mobile)-trace\.zip|action-(?:desktop|mobile)-\d{1,2}\.png)$/;
export const runId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function sameSecret(actual: string, expected: string): boolean {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(actual), hash(expected));
}

export class Admission {
  private attempts: number[] = [];
  private active = false;
  private unhealthy = false;

  acquire(now = Date.now()): () => void {
    if (this.unhealthy) throw new TraceError("Investigations are temporarily unavailable.", 503);
    if (this.active) throw new TraceError("Another investigation is running. Please try later.", 429);
    this.attempts = this.attempts.filter((time) => now - time < 3_600_000);
    if (this.attempts.length >= 12 || this.attempts.some((time) => now - time < 15_000)) {
      throw new TraceError("The demo has reached its usage limit. Please try later.", 429);
    }
    this.attempts.push(now);
    this.active = true;
    return () => { this.active = false; };
  }

  disable() { this.unhealthy = true; }
}

interface SavedRun { report: CaptureReport; artifacts: Map<string, Buffer>; token: string; expires: number }

export class EvidenceStore {
  private runs = new Map<string, SavedRun>();

  prune(now = Date.now()) {
    for (const [id, run] of this.runs) if (run.expires <= now) this.runs.delete(id);
  }

  save(bundle: unknown, now = Date.now()): { report: CaptureReport; accessToken: string } {
    this.prune(now);
    if (this.runs.size >= 4) throw new TraceError("The demo evidence storage is full. Please try later.", 429);
    if (!bundle || typeof bundle !== "object" || !("report" in bundle) || !("artifacts" in bundle)) throw new Error("Invalid worker result");
    const report = bundle.report as CaptureReport;
    if (!report || !runId.test(report.id) || !Array.isArray(report.findings) || !Array.isArray(report.actions)) throw new Error("Invalid report");
    if (this.runs.has(report.id)) throw new Error("Duplicate run ID");
    const serialized = JSON.stringify(report);
    if (Buffer.byteLength(serialized) > 512 * 1024) throw new Error("Report limit exceeded");
    const raw = bundle.artifacts;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid artifacts");
    const artifacts = new Map<string, Buffer>();
    let bytes = 0;
    for (const [name, value] of Object.entries(raw)) {
      if (!artifactName.test(name) || typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Invalid artifact");
      const contents = Buffer.from(value, "base64");
      bytes += contents.length;
      if (bytes > 24 * 1024 * 1024) throw new Error("Evidence limit exceeded");
      if (name.endsWith(".png") && contents.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Invalid image");
      artifacts.set(name, contents);
    }
    if (!artifacts.has("screenshot.png") || !artifacts.has("mobile.png")) throw new Error("Missing screenshots");
    // Serve our own report serialization rather than a separate worker-supplied document.
    artifacts.set("report.json", Buffer.from(serialized));
    const token = randomBytes(32).toString("hex");
    this.runs.set(report.id, { report, artifacts, token, expires: now + 15 * 60_000 });
    return { report, accessToken: token };
  }

  get(id: string, name: string, token: string, now = Date.now()): Buffer | undefined {
    this.prune(now);
    const run = this.runs.get(id);
    if (!run || !sameSecret(token, run.token) || !artifactName.test(name)) return;
    return run.artifacts.get(name);
  }
}
