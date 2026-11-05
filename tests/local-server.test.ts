import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalServer } from "../src/local-server.ts";
import type { BasicReport } from "../src/basic-check.ts";

test("API enforces three checks across refresh, spoofed IP headers, and server restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-server-"));
  let calls = 0;
  const investigate = async (): Promise<BasicReport> => {
    calls++;
    return {
      id: "fixture",
      requestedUrl: "https://8.8.8.8/",
      finalUrl: "https://8.8.8.8/",
      title: "Test fixture",
      status: 200,
      connection: "https",
      capturedAt: new Date().toISOString(),
      durationMs: 1,
      findings: [],
      checked: [],
      incomplete: false,
      limits: [],
      text: "Test fixture report",
    };
  };
  let trace = await createLocalServer({ port: 0, directory, investigate });
  const listen = async () => {
    await new Promise<void>((resolve) =>
      trace.server.listen(0, "127.0.0.1", resolve),
    );
    const address = trace.server.address();
    assert(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  let origin = await listen();
  const post = (url: string, extra: Record<string, string> = {}) =>
    fetch(`${origin}/api/captures`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...extra },
      body: JSON.stringify({ url }),
    });
  try {
    assert.equal((await post("http://127.0.0.1")).status, 422);
    assert.equal(
      (await post("https://8.8.8.8", { Origin: "https://evil.example" }))
        .status,
      403,
    );
    assert.equal(
      (await (await fetch(`${origin}/api/usage`)).json()).remaining,
      3,
    );
    for (let index = 0; index < 3; index++) {
      const response = await post("https://8.8.8.8", {
        "X-Forwarded-For": `192.0.2.${index + 1}`,
        "CF-Connecting-IP": `192.0.2.${index + 1}`,
      });
      assert.equal(response.status, 201);
      assert.equal((await response.json()).usage.remaining, 2 - index);
      assert.equal(
        (await (await fetch(`${origin}/api/usage`)).json()).remaining,
        2 - index,
      );
    }
    let denied = await post("https://8.8.8.8", {
      "X-Forwarded-For": "203.0.113.10",
    });
    assert.equal(denied.status, 429);
    assert(Number(denied.headers.get("retry-after")) > 0);
    assert.equal(calls, 3);
    await new Promise<void>((resolve) => trace.server.close(() => resolve()));
    trace = await createLocalServer({
      port: 0,
      directory,
      investigate,
      unlimited: true,
    });
    origin = await listen();
    for (let index = 0; index < 5; index++) {
      const response = await post("https://8.8.8.8");
      assert.equal(response.status, 201);
      assert.equal((await response.json()).usage.unlimited, true);
    }
    assert.equal(calls, 8);
    await new Promise<void>((resolve) => trace.server.close(() => resolve()));
    trace = await createLocalServer({ port: 0, directory, investigate });
    origin = await listen();
    denied = await post("https://8.8.8.8");
    assert.equal(denied.status, 429);
    assert.equal(calls, 8);
  } finally {
    await new Promise<void>((resolve) => trace.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a temporary local debug deadline bypasses quota only until it expires", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-debug-quota-"));
  const debugDirectory = path.join(directory, "data/usage");
  await mkdir(debugDirectory, { recursive: true });
  const debugDeadlineFile = path.join(debugDirectory, "local-unlimited-until");
  await writeFile(
    debugDeadlineFile,
    new Date(Date.now() + 60_000).toISOString(),
    { mode: 0o600 },
  );
  let calls = 0;
  const investigate = async (): Promise<BasicReport> => {
    calls++;
    return {
      id: "fixture",
      requestedUrl: "https://8.8.8.8/",
      finalUrl: "https://8.8.8.8/",
      title: "Test fixture",
      status: 200,
      connection: "https",
      capturedAt: new Date().toISOString(),
      durationMs: 1,
      findings: [],
      checked: [],
      incomplete: false,
      limits: [],
      text: "Test fixture report",
    };
  };
  let trace = await createLocalServer({ port: 0, directory, investigate });
  const listen = async () => {
    await new Promise<void>((resolve) =>
      trace.server.listen(0, "127.0.0.1", resolve),
    );
    const address = trace.server.address();
    assert(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  let origin = await listen();
  const post = () =>
    fetch(`${origin}/api/captures`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ url: "https://8.8.8.8" }),
    });
  try {
    const enabledUsage = await (await fetch(`${origin}/api/usage`)).json();
    assert.deepEqual(enabledUsage, {
      remaining: 3,
      retryAt: null,
      unlimited: true,
    });
    for (let index = 0; index < 5; index++) {
      const response = await post();
      assert.equal(response.status, 201);
      assert.deepEqual((await response.json()).usage, enabledUsage);
    }
    assert.equal(calls, 5);
    await new Promise<void>((resolve) => trace.server.close(() => resolve()));

    await writeFile(
      debugDeadlineFile,
      new Date(Date.now() - 1_000).toISOString(),
      { mode: 0o600 },
    );
    trace = await createLocalServer({ port: 0, directory, investigate });
    origin = await listen();
    const expiredUsage = await (await fetch(`${origin}/api/usage`)).json();
    assert.deepEqual(expiredUsage, { remaining: 3, retryAt: null });
    const response = await post();
    assert.equal(response.status, 201);
    assert.deepEqual((await response.json()).usage, {
      remaining: 2,
      retryAt: null,
    });
    assert.equal(calls, 6);
  } finally {
    await new Promise<void>((resolve) => trace.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
