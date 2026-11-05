import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { checkMobileOverflow, observePage } from "../src/checks.ts";

test("browser checks preserve real failure evidence and distinguish clean layouts", { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ channel: process.env.TRACE_BROWSER_CHANNEL || undefined });
  try {
    const viewport = { width: 390, height: 844 };
    const page = await browser.newPage({ viewport });
    await page.route("https://fixture.example/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/missing.png") return route.fulfill({ status: 404, body: "Missing" });
      if (pathname === "/failed.css") return route.abort("connectionfailed");
      if (pathname === "/blocked") return route.abort();
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width"><title>Fixture</title><link rel="stylesheet" href="/failed.css"><img src="/missing.png"><div id="wide" style="width:600px;height:40px">Wide</div><script>fetch('/blocked', {method:'POST'}).catch(() => {}); throw new Error('Fixture script failed');</script>` });
    });
    const checks = observePage(page, viewport);
    await page.goto("https://fixture.example/", { waitUntil: "load" });
    const overflow = await checkMobileOverflow(page, viewport);
    checks.stop();
    assert(checks.findings.some((finding) => finding.kind === "javascript-error" && finding.evidence.message === "Fixture script failed"));
    assert(checks.findings.some((finding) => finding.evidence.status === 404 && finding.evidence.url === "https://fixture.example/missing.png"));
    assert(checks.findings.some((finding) => finding.evidence.url === "https://fixture.example/failed.css" && String(finding.evidence.error).includes("ERR_CONNECTION_FAILED")));
    assert(!checks.findings.some((finding) => finding.evidence.url === "https://fixture.example/blocked"));
    assert.equal(overflow?.kind, "mobile-overflow");
    assert((overflow!.evidence.documentWidth as number) > 390);
    assert(JSON.stringify(overflow!.evidence.elements).includes("wide"));
    assert(checks.findings.every((finding) => finding.pageUrl === "https://fixture.example/" && finding.reproduce.length > 0));

    await page.setContent('<!doctype html><meta name="viewport" content="width=device-width"><p>A responsive page</p>');
    assert.equal(await checkMobileOverflow(page, viewport), undefined);
    const clean = observePage(page, viewport);
    await page.evaluate(() => { for (let i = 0; i < 110; i++) setTimeout(() => { throw new Error("Repeated"); }, 0); });
    await page.waitForTimeout(200);
    clean.stop();
    assert.equal(clean.findings.length, 100);
    assert.equal(clean.omittedFindings, 10);
    await page.evaluate(() => { setTimeout(() => { throw new Error("After observation"); }, 0); });
    await page.waitForTimeout(100);
    assert.equal(clean.omittedFindings, 10);
  } finally {
    await browser.close();
  }
});
