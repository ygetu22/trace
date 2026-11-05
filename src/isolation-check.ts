import { runContainer, verifyIsolation } from "./container-runner.ts";

// Run inside the same network and sandbox configuration used by actual jobs.
const script = `
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('playwright');
function request(host, port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: 3000 }, res => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}
(async () => {
  await assert.rejects(request('1.1.1.1', 80, '/'));
  await assert.rejects(request('172.30.0.1', 3121, '/'));
  assert.equal(await request('172.30.0.2', 8080, 'http://169.254.169.254/latest/meta-data/'), 403);
  assert.equal(await request('172.30.0.2', 8080, 'http://127.0.0.1/'), 403);
  assert.equal(await request('172.30.0.2', 8080, 'http://[::1]/'), 403);
  const browser = await chromium.launch({ chromiumSandbox: true, proxy: { server: 'http://172.30.0.2:8080', bypass: '<-loopback>' } });
  try {
    const page = await browser.newPage();
    const response = await page.goto('https://example.com', {timeout: 20000});
    assert.equal(response.status(), 200);
    assert.equal(await page.title(), 'Example Domain');
  } finally { await browser.close(); }
  process.stdout.write(JSON.stringify({ ok: true }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;
export async function checkIsolation() {
  await verifyIsolation();
  const result = await runContainer(null, AbortSignal.timeout(45_000), () => {}, ["node", "-e", script]);
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) throw new Error("Isolation check failed");
}

if (process.argv[1]?.endsWith("isolation-check.js")) {
  await checkIsolation();
  console.log("Passed: direct egress blocked, metadata/loopback rejected, sandboxed public HTTPS works.");
}
