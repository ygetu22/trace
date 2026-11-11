import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import ipaddr from "ipaddr.js";
import { TraceError } from "./errors.ts";

const windowMs = 24 * 60 * 60_000;
const limit = 3;
interface Ledger { version: 1; clients: Record<string, number[]> }
export interface Usage { remaining: number; retryAt: string | null; unlimited?: boolean }

// Checks the outer shape of quota.json; each client entry is validated separately.
function hasLedgerShape(
  value: unknown,
): value is { version: 1; clients: Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "clients" in value &&
    typeof value.clients === "object" &&
    value.clients !== null &&
    !Array.isArray(value.clients)
  );
}

export class DailyQuota {
  private ledger: Ledger = { version: 1, clients: {} };
  private salt = "";
  private pending: Promise<unknown> = Promise.resolve();

  private directory: string;

  private constructor(directory: string) {
    this.directory = directory;
  }

  static async open(directory: string): Promise<DailyQuota> {
    const quota = new DailyQuota(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const saltPath = path.join(directory, "quota-salt");
    try {
      quota.salt = await readFile(saltPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const ledgerExists = await readFile(path.join(directory, "quota.json")).then(() => true).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code !== "ENOENT") throw failure;
        return false;
      });
      if (ledgerExists) throw new Error("The quota salt is missing. Restore it before restarting Trace.");
      quota.salt = randomBytes(32).toString("hex");
      await writeFile(saltPath, quota.salt, { flag: "wx", mode: 0o600 });
    }
    if (!/^[a-f0-9]{64}$/.test(quota.salt)) throw new Error("Trace's quota salt is invalid. Restore the quota data before restarting.");
    try {
      const saved: unknown = JSON.parse(await readFile(path.join(directory, "quota.json"), "utf8"));
      if (!hasLedgerShape(saved)) throw new Error("Invalid quota ledger");
      for (const [key, timestamps] of Object.entries(saved.clients)) {
        const isValidEntry =
          /^[a-f0-9]{64}$/.test(key) &&
          Array.isArray(timestamps) &&
          timestamps.length <= limit &&
          timestamps.every((time) => Number.isSafeInteger(time) && time >= 0);
        if (!isValidEntry) throw new Error("Invalid quota ledger");
      }
      quota.ledger = saved as Ledger;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return quota;
  }

  private key(address: string): string {
    if (!ipaddr.isValid(address)) throw new TraceError("The client address could not be identified.", 503);
    return createHmac("sha256", this.salt).update(ipaddr.process(address).toString()).digest("hex");
  }

  private usage(timestamps: number[]): Usage {
    // The limit frees up when the oldest check in the window expires.
    const retryAt =
      timestamps.length >= limit
        ? new Date(Math.min(...timestamps) + windowMs).toISOString()
        : null;
    return { remaining: Math.max(0, limit - timestamps.length), retryAt };
  }

  async peek(address: string, now = Date.now()): Promise<Usage> {
    await this.pending;
    return this.usage((this.ledger.clients[this.key(address)] ?? []).filter((time) => time > now - windowMs));
  }

  consume(address: string, now = Date.now()): Promise<Usage> {
    const operation = this.pending.then(async () => {
      const key = this.key(address);
      const clients: Record<string, number[]> = {};
      for (const [client, times] of Object.entries(this.ledger.clients)) {
        const recent = times.filter((time) => time > now - windowMs);
        if (recent.length) clients[client] = recent;
      }
      const timestamps = clients[key] ?? [];
      if (timestamps.length >= limit) {
        throw new TraceError(
          "This IP has used its 3 checks in the last 24 hours. Please try again after the reset time shown below.",
          429,
        );
      }
      if (!clients[key] && Object.keys(clients).length >= 10_000) throw new TraceError("Trace's usage tracking is full. Please try later.", 503);
      clients[key] = [...timestamps, now];
      const next: Ledger = { version: 1, clients };
      const temporary = path.join(this.directory, "quota.json.tmp");
      // Reserve durably before browser work; failed writes cannot grant a check.
      await writeFile(temporary, JSON.stringify(next) + "\n", { mode: 0o600 });
      await rename(temporary, path.join(this.directory, "quota.json"));
      this.ledger = next;
      return this.usage(clients[key]);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
