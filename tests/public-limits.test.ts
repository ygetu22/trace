import assert from "node:assert/strict";
import test from "node:test";
import { Admission, EvidenceStore, sameSecret } from "../src/public-limits.ts";
import { browserEnvironment } from "../src/capture.ts";

test("browser environment excludes service keys and cloud credentials", () => {
  assert.deepEqual(browserEnvironment({ PATH: "/bin", HOME: "/tmp", TRACE_SERVICE_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", OPENAI_API_KEY: "secret", NODE_OPTIONS: "--require=evil" }), { PATH: "/bin", HOME: "/tmp" });
});

test("admission enforces one active job, cooldown, hourly budget, and cleanup failure lockout", () => {
  const admission = new Admission();
  let release = admission.acquire(0);
  assert.throws(() => admission.acquire(16_000), /Another investigation/);
  release();
  assert.throws(() => admission.acquire(14_999), /usage limit/);
  for (let index = 1; index < 12; index++) { release = admission.acquire(index * 15_000); release(); }
  assert.throws(() => admission.acquire(180_000), /usage limit/);
  admission.acquire(3_600_000)();
  admission.disable();
  assert.throws(() => admission.acquire(7_200_000), /unavailable/);
});

function bundle(id = "00000000-0000-0000-0000-000000000001") {
  return { report: { id, findings: [], actions: [] }, artifacts: { "screenshot.png": "iVBORw0KGgo=", "mobile.png": "iVBORw0KGgo=" } };
}

test("evidence requires the correct per-run token and expires; names cannot escape storage", () => {
  const store = new EvidenceStore();
  const saved = store.save(bundle(), 0);
  assert.throws(() => store.save(bundle(), 0), /Duplicate run ID/);
  assert.equal(store.get(saved.report.id, "screenshot.png", "wrong", 0), undefined);
  assert(store.get(saved.report.id, "screenshot.png", saved.accessToken, 0));
  assert.equal(store.get(saved.report.id, "../secret", saved.accessToken, 0), undefined);
  assert.equal(store.get(saved.report.id, "screenshot.png", saved.accessToken, 900_000), undefined);
  assert.equal(sameSecret("", saved.accessToken), false);
});

test("evidence rejects unexpected files and caps retained runs", () => {
  const store = new EvidenceStore();
  assert.throws(() => store.save({ ...bundle(), artifacts: { "../secret": "" } }), /Invalid artifact/);
  assert.throws(() => store.save({ ...bundle(), artifacts: { "screenshot.png": "PHNjcmlwdD4=" } }), /Invalid image/);
  for (let index = 1; index <= 4; index++) store.save(bundle(`00000000-0000-0000-0000-00000000000${index}`), 0);
  assert.throws(() => store.save(bundle(), 1), /storage is full/);
  store.save(bundle(), 900_000);
});
