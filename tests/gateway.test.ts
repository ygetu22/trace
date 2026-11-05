import assert from "node:assert/strict";
import test from "node:test";
import { createGateway } from "../src/gateway-server.ts";

const secret = "test-only-".repeat(5);

test("gateway denies browser origins and wrong service keys before launching a worker", async () => {
  let launches = 0;
  const gateway = createGateway(secret, async () => { launches++; throw new Error("Must not launch"); });
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/captures`;
  try {
    const deniedHeaders: Record<string, string>[] = [
      { "Content-Type": "application/json" },
      { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, Origin: "https://evil.example" },
    ];
    for (const headers of deniedHeaders) {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ url: "https://example.com" }) });
      assert.equal(response.status, 403);
    }
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` }, body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }) });
    assert.equal(response.status, 422);
    assert.equal(launches, 0);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally { await new Promise<void>((resolve) => gateway.server.close(() => resolve())); }
});

test("gateway evidence routes deny guessed run IDs and unsafe filenames", async () => {
  const gateway = createGateway(secret);
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert(address && typeof address !== "string");
  try {
    for (const name of ["screenshot.png", "page.html", "%2e%2e%2fsecret"]) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/runs/00000000-0000-0000-0000-000000000001/${name}`, { headers: { Authorization: `Bearer ${secret}`, "X-Trace-Access": "wrong" } });
      assert.equal(response.status, 404);
    }
  } finally { await new Promise<void>((resolve) => gateway.server.close(() => resolve())); }
});
