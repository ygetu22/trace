import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";
import test, { before, after } from "node:test";
import { chromium, type Browser } from "playwright";
import { observePage } from "../src/checks.ts";
import { exploreForms } from "../src/form-interactions.ts";
import { exploreSearch } from "../src/search-interactions.ts";

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ channel: process.env.TRACE_BROWSER_CHANNEL || undefined });
});
after(async () => { await browser?.close(); });

async function fixture(html: string, resultStatus = 200) {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
  const requests: { url: string; method: string }[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    response.setHeader("Content-Type", "text/html");
    if (url.pathname === "/") { response.end(html); return; }
    requests.push({ url: url.href, method: request.method ?? "GET" });
    response.writeHead(resultStatus);
    response.end("<h1>Search result fixture</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  context.once("close", () => { server.close(); server.closeAllConnections(); });
  await context.routeWebSocket("**/*", socket => socket.close());
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  return { context, page, requests };
}

test("form editing and native validation stay isolated from network handlers", { timeout: 15_000 }, async () => {
  const { context, page, requests } = await fixture(`<!doctype html><form aria-label="Contact">
    <label>Name <input name="name" required></label>
    <label>Topic <select><option value="first">First</option><option value="second">Second</option></select></label>
    <label>Updates <input type="checkbox"></label><button>Send message</button></form>
    <script>
      document.querySelector('input').addEventListener('input', () => {
        fetch('/leak-now?q=' + encodeURIComponent(document.querySelector('input').value)).catch(() => {});
        setTimeout(() => fetch('/leak-later').catch(() => {}), 300);
      });
      document.querySelector('select').onchange = () => fetch('/save', {method:'POST'}).catch(() => {});
    </script>`);
  const observations = observePage(page, { width: 390, height: 844 });
  try {
    const result = await exploreForms(page, performance.now() + 15_000);
    await page.waitForTimeout(400);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0]!.outcome, "passed");
    assert.match(result.actions[0]!.detail, /browser rejected an empty required field/);
    assert.match(result.actions[0]!.detail, /dropdown selection changed/);
    assert.match(result.actions[0]!.detail, /checkbox toggled/);
    assert.deepEqual(requests, [], "No input/change/debounce requests should reach the fixture server.");
    assert(!observations.findings.some(finding => finding.kind === "failed-resource"));
    assert(!result.findings.some(finding => finding.classification === "issue"));
  } finally { observations.stop(); await context.close(); }
});

test("sensitive forms are skipped without filling or submitting", async () => {
  const { context, page, requests } = await fixture('<form aria-label="Sign in"><input type="password"><button>Continue</button></form>');
  try {
    const result = await exploreForms(page, performance.now() + 15_000);
    assert.deepEqual(result.actions, []);
    assert.match(result.skipped[0]!, /authentication, payment, or upload/);
    assert.equal(await page.locator('input').inputValue(), "");
    assert.deepEqual(requests, []);
  } finally { await context.close(); }
});

test("forms respect the remaining time budget without editing", async () => {
  const { context, page } = await fixture('<form><input name="name"><button>Continue</button></form>');
  try {
    const result = await exploreForms(page, performance.now());
    assert.equal(result.limited, true);
    assert.deepEqual(result.actions, []);
    assert.equal(await page.locator('input').inputValue(), "");
  } finally { await context.close(); }
});

test("search uses the sample query and keeps relevance unverified", async () => {
  const { context, page, requests } = await fixture('<form role="search" action="/search"><input type="search" name="q"></form>');
  try {
    const result = await exploreSearch(page, performance.now() + 15_000);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, "GET");
    assert.equal(new URL(requests[0]!.url).searchParams.get('q'), "trace");
    assert.equal(result.actions[0]!.outcome, "review");
    assert.match(result.actions[0]!.detail, /relevance still needs an owner-provided expectation/);
    assert.deepEqual(result.findings, []);
  } finally { await context.close(); }
});

test("an actual search HTTP failure is reported with evidence", async () => {
  const { context, page } = await fixture('<form action="/search"><input type="search" name="q"></form>', 500);
  try {
    const result = await exploreSearch(page, performance.now() + 15_000);
    assert.equal(result.actions[0]!.outcome, "failed");
    assert.match(result.actions[0]!.detail, /HTTP 500/);
    assert.equal(result.findings[0]!.classification, "issue");
  } finally { await context.close(); }
});

test("search skips forms with other named controls, unsafe methods, or destinations", async () => {
  const forms = [
    '<form action="/search"><input type="search" name="q"><select name="category"><option>All</option></select></form>',
    '<form action="/search"><input type="search" name="q"><textarea name="notes">Private notes</textarea></form>',
    '<form action="/search"><input type="search" name="q"><input type="hidden" name="action" value="delete"></form>',
    '<form action="/search"><input type="search" name="q"><button name="action" value="delete">Search</button></form>',
    '<form action="/search"><input type="search" name="q"><input name="method" value="post"></form>',
    '<form method="post" action="/search"><input type="search" name="q"></form>',
    '<form action="https://other.example/search"><input type="search" name="q"></form>',
    '<form action="/delete"><input type="search" name="q"></form>',
  ];
  for (const html of forms) {
    const { context, page, requests } = await fixture(html);
    try {
      const result = await exploreSearch(page, performance.now() + 15_000);
      assert.deepEqual(result.actions, [], html);
      assert(result.skipped.length > 0, html);
      assert.equal(await page.locator('input[type=search]').inputValue(), "");
      assert.deepEqual(requests, []);
    } finally { await context.close(); }
  }
});
