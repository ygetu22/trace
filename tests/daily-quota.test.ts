import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DailyQuota } from "../src/daily-quota.ts";

test("three checks survive a new quota instance and IPv4-mapped addresses cannot bypass it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-quota-"));
  try {
    let quota = await DailyQuota.open(directory);
    const now = Date.now();
    assert.equal((await quota.consume("127.0.0.1", now)).remaining, 2);
    quota = await DailyQuota.open(directory);
    assert.equal((await quota.consume("::ffff:127.0.0.1", now + 1)).remaining, 1);
    assert.equal((await quota.consume("127.0.0.1", now + 2)).remaining, 0);
    await assert.rejects(quota.consume("127.0.0.1", now + 3), /3 checks/);
    assert.equal((await quota.peek("127.0.0.1", now + 86_400_000)).remaining, 1);
    assert.equal((await quota.peek("192.0.2.1", now)).remaining, 3);
    const saved = await readFile(path.join(directory, "quota.json"), "utf8");
    assert(!saved.includes("127.0.0.1"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("concurrent reservations admit exactly three and a corrupt ledger does not reset usage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-quota-"));
  try {
    const quota = await DailyQuota.open(directory);
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => quota.consume("192.0.2.1")));
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 3);
    await writeFile(path.join(directory, "quota.json"), "broken");
    await assert.rejects(DailyQuota.open(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing salt cannot reset an existing ledger", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-quota-"));
  try {
    const quota = await DailyQuota.open(directory);
    await quota.consume("192.0.2.1");
    await unlink(path.join(directory, "quota-salt"));
    await assert.rejects(DailyQuota.open(directory), /salt is missing/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
