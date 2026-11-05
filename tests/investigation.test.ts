import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { chromium } from "playwright";
import { inspectPage, observePage } from "../src/checks.ts";
import { explorePage, parseFeatureCheck } from "../src/explore.ts";

test("feature check input is explicit and bounded", () => {
  assert.equal(parseFeatureCheck(undefined), undefined);
  assert.deepEqual(parseFeatureCheck({ label: " Open menu ", expectedText: " Pricing " }), { label: "Open menu", expectedText: "Pricing" });
  for (const input of [{ label: "Menu" }, { label: "", expectedText: "Pricing" }, { label: "a".repeat(201), expectedText: "Pricing" }, "Open menu"]) {
    assert.throws(() => parseFeatureCheck(input), /feature check needs/);
  }
});

test("feature assertions distinguish a real result, a failure, and blocked or ambiguous checks", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-feature-"));
  const browser = await chromium.launch({ channel: process.env.TRACE_BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route("https://fixture.example/**", (route) => {
      if (route.request().method() === "POST") return route.abort();
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><button onclick="document.getElementById('content').hidden=false">Show pricing</button><p id="content" hidden>Plans start at $10</p><button>Broken action</button><button onclick="fetch('/data',{method:'POST'}).catch(()=>{})">Load data</button>` });
    });
    for (const [label, expectedText, outcome] of [
      ["Show pricing", "Plans start at $10", "passed"],
      ["Broken action", "Plans start at $10", "failed"],
      ["Load data", "Results loaded", "review"],
      ["Missing button", "Results loaded", "review"],
      ["Show pricing", "Broken action", "review"],
    ] as const) {
      await page.goto("https://fixture.example/", { waitUntil: "load" });
      const result = await explorePage(page, directory, "/runs/fixture", "desktop", performance.now() + 10_000, false, { label, expectedText });
      assert.equal(result.actions[0]?.kind, "feature");
      assert.equal(result.actions[0]?.outcome, outcome, JSON.stringify(result));
      if (outcome === "failed") assert(result.findings.some((finding) => finding.classification === "issue" && finding.evidence.expectedText === expectedText));
      if (outcome === "review") assert(!result.findings.some((finding) => finding.classification === "issue"));
    }
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspection distinguishes transport failures, broken UI, and header recommendations", { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ channel: process.env.TRACE_BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Fixture</title><img src="/bad.png"><form action="http://fixture.example/send"><input id="email" placeholder="Email"><input id="named" aria-label="Name"></form>` }));
    await page.goto("https://fixture.example", { waitUntil: "load" });
    const findings = await inspectPage(page, 404, {});
    assert(findings.some((finding) => finding.kind === "page-response" && finding.classification === "issue"));
    assert(findings.some((finding) => finding.kind === "broken-image"));
    assert(findings.some((finding) => finding.kind === "form-label" && JSON.stringify(finding.evidence).includes("email") && !JSON.stringify(finding.evidence).includes('"named"')));
    assert(findings.some((finding) => finding.summary === "Form targets use HTTP"));
    assert(!findings.some((finding) => finding.summary.includes("unencrypted HTTP")));
    assert.equal(findings.filter(finding => finding.kind === "security" && finding.classification === "recommendation").length, 5);
    assert(findings.some(finding => finding.kind === "search-preview"));
    await page.goto("http://fixture.example", { waitUntil: "load" });
    assert((await inspectPage(page, 200, {})).some((finding) => finding.summary.includes("unencrypted HTTP")));
    await page.goto("https://fixture.example", { waitUntil: "load" });
    await page.setContent('<!doctype html><html lang="en"><head><title>Clean fixture</title><meta name="description" content="A complete test fixture."><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src https:"></head><body><h1>Clean fixture</h1></body></html>');
    const clean = await inspectPage(page, 200, { "strict-transport-security": "max-age=31536000", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "DENY" });
    assert.deepEqual(clean, []);
    await page.setContent('<title>Just a moment...</title><form id="challenge-form">Checking your browser</form>');
    assert((await inspectPage(page, 403, {})).some((finding) => finding.kind === "access-challenge" && finding.classification === "review"));
  } finally { await browser.close(); }
});

test("exploration actually clicks controls and links, preserves evidence, and skips writes", { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-explore-"));
  const browser = await chromium.launch({ channel: process.env.TRACE_BROWSER_CHANNEL || undefined });
  const server = http.createServer();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    server.on("request", (request, response) => {
      const pathname = request.url;
      if (pathname === "/redirect") { response.writeHead(302, { location: "/gone" }); response.end(); return; }
      response.setHeader("Content-Type", "text/html");
      if (pathname === "/gone") { response.writeHead(404); response.end("<h1>Missing</h1>"); return; }
      if (pathname === "/good") { response.end("<h1>Working page</h1>"); return; }
      response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Interactive fixture</title>
        <button aria-expanded="false" onclick="window.deleted=true">Delete account</button>
        <form><button aria-expanded="false" onclick="window.submitted=true">Form control</button></form>
        <button aria-expanded="false" aria-controls="menu" onclick="this.setAttribute('aria-expanded','true');document.getElementById('menu').hidden=false">Open menu</button><div id="menu" hidden>Menu content</div>
        <button aria-expanded="false" aria-controls="broken">Broken menu</button><div id="broken" hidden>Hidden</div>
        <button role="tab" aria-selected="false" aria-controls="panel" onclick="this.setAttribute('aria-selected','true');document.getElementById('panel').hidden=false">Reviews</button><div id="panel" hidden>Reviews shown</div>
        <details><summary>Details</summary>Details shown</details>
        <main id="main-content">Home content</main><a href="/good">Working link</a><a href="/redirect">Broken link</a><a href="/spa" onclick="event.preventDefault();history.pushState({},'', '/spa');document.getElementById('main-content').textContent='Client route content'">Client-side link</a><a href="/logout">Log out</a><a href="/search?q=test">Search</a><a href="https://other.example/">External</a>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as import("node:net").AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    await page.goto(`${origin}/`, { waitUntil: "load" });
    const observations = observePage(page, { width: 390, height: 844 });
    const result = await explorePage(page, directory, "/runs/fixture", "mobile", performance.now() + 30_000, true);
    observations.stop();
    const entryControls = result.actions.filter(action => action.kind === "control" && action.beforeUrl === `${origin}/`);
    assert.equal(entryControls.length, 4);
    assert.equal(entryControls.filter(action => action.outcome === "passed").length, 3);
    assert(result.findings.some((finding) => finding.kind === "interaction" && finding.classification === "issue" && finding.reproduce[1] === 'Click “Broken menu”.'));
    assert(result.actions.some((action) => action.kind === "navigation" && action.outcome === "passed" && action.afterUrl.endsWith("/good")));
    assert(result.findings.some((finding) => finding.kind === "broken-link" && finding.evidence.status === 404 && finding.evidence.finalUrl === `${origin}/gone`));
    assert(result.actions.some((action) => action.label === "Client-side link" && action.outcome === "passed" && action.detail.includes("page content changed") && !action.detail.includes("HTTP")));
    assert(result.skipped.some((reason) => reason.includes("Delete account")));
    assert(!result.actions.some((action) => /Log out|Search|External|Delete account|Form control/.test(action.label)));
    for (const action of result.actions) {
      assert(action.durationMs > 0);
      if (action.kind === "form" || action.kind === "search") continue;
      assert(action.beforeScreenshotUrl && action.afterScreenshotUrl);
      const filename = action.afterScreenshotUrl.split("/").at(-1)!;
      assert.equal((await readFile(path.join(directory, filename))).subarray(1, 4).toString(), "PNG");
    }
    assert.deepEqual(observations.findings, []);
    await page.goto(`${origin}/`, { waitUntil: "load" });
    const bounded = await explorePage(page, directory, "/runs/fixture", "desktop", performance.now(), true);
    assert.equal(bounded.limited, true);
    assert.deepEqual(bounded.actions, []);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
