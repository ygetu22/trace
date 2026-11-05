import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { startOutboundProxy } from "../src/outbound-proxy.ts";

test("the proxy rejects loopback HTTP requests without contacting the destination", async () => {
  let hits = 0;
  const destination = http.createServer((_, response) => { hits++; response.end("private"); });
  await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const proxy = await startOutboundProxy();
  try {
    const address = destination.address();
    assert(address && typeof address !== "string");
    for (const target of [`http://127.0.0.1:${address.port}/secret`, "http://127.0.0.1/secret", "http://[::1]/secret"]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = http.get(proxy.url, { path: target }, (response) => {
          response.resume();
          resolve(response.statusCode);
        });
        request.on("error", reject);
      });
      assert.equal(status, 403, target);
    }
    assert.equal(hits, 0);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => destination.close(() => resolve()));
  }
});

test("HTTPS tunnels reject private addresses and non-standard ports", async () => {
  const proxy = await startOutboundProxy();
  try {
    for (const target of ["127.0.0.1:443", "[::1]:443", "example.com:3120"]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = http.request(proxy.url, { method: "CONNECT", path: target });
        request.on("connect", (response, socket) => { socket.destroy(); resolve(response.statusCode); });
        request.on("error", reject);
        request.end();
      });
      assert.equal(status, 403, target);
    }
  } finally {
    await proxy.close();
  }
});
