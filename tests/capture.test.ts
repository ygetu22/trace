import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { capturePage } from "../src/capture.ts";

test("capture rejects a private target before browser launch", async () => {
  await assert.rejects(capturePage("http://127.0.0.1", "/unused", new AbortController().signal), /public internet/);
});

test("an already cancelled capture does not resolve or launch a browser", async () => {
  await assert.rejects(capturePage("https://example.com", "/unused", AbortSignal.abort()), /cancelled/);
});

for (const url of ["https://example.com", "https://playwright.dev"]) {
  test(`captures a real public page: ${url}`, { skip: process.env.TRACE_LIVE_TESTS !== "1", timeout: 100_000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trace-test-"));
    try {
      const report = await capturePage(url, directory, AbortSignal.timeout(90_000));
      assert.equal(report.status, 200);
      assert(report.title.length > 0);
      const screenshot = await readFile(path.join(directory, report.id, "screenshot.png"));
      assert.equal(screenshot.subarray(1, 4).toString(), "PNG");
      const saved = JSON.parse(await readFile(path.join(directory, report.id, "report.json"), "utf8"));
      assert.equal(saved.finalUrl, report.finalUrl);
      assert.equal(saved.status, report.status);
      assert.equal(saved.mobile.viewport.width, 390);
      assert(Array.isArray(saved.findings));
      const mobile = await readFile(path.join(directory, report.id, "mobile.png"));
      assert.equal(mobile.subarray(1, 4).toString(), "PNG");
      assert.equal(report.security.https, true);
      assert(report.coverage.pagesVisited >= 2);
      for (const file of ["desktop-trace.zip", "mobile-trace.zip"]) {
        assert.equal((await readFile(path.join(directory, report.id, file))).subarray(0, 2).toString(), "PK");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
