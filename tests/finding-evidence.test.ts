import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { inspectPage } from "../src/checks.ts";
import { createEvidenceRecorder } from "../src/screenshot-evidence.ts";
import { buildReportPresentation } from "../src/report.ts";
import { waitForPageContent } from "../src/page-content.ts";
import { explorePage } from "../src/explore.ts";
import { tryLocationSearch } from "../src/location-search.ts";
import type { BasicReport } from "../src/basic-check.ts";

const launch = () =>
  chromium.launch({ channel: process.env.TRACE_BROWSER_CHANNEL || undefined });

test("visual findings carry actual target screenshots, red markers, and reusable card references", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 500, height: 400 },
    });
    await page.route("https://fixture.example/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html lang=en><style>body{background:white;color:black}img{width:90px;height:60px}button{width:40px;height:30px}.low{color:#aaa;background:white}</style><main><h1>Fixture</h1><img id=photo src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='90' height='60'%3E%3Crect width='90' height='60' fill='black'/%3E%3C/svg%3E"><button id=unnamed></button><p class=low>Low contrast text</p><a href='/details' tabindex=-1>Details</a></main></html>`,
      }),
    );
    await page.goto("https://fixture.example/");
    const findings = await inspectPage(page, 200, {});
    const recorder = createEvidenceRecorder();
    await recorder.recordFindings(page, findings);
    const report: Omit<BasicReport, "text"> = {
      id: "fixture",
      title: "Fixture",
      requestedUrl: page.url(),
      finalUrl: page.url(),
      status: 200,
      connection: "https",
      capturedAt: "",
      durationMs: 1,
      checked: [],
      findings,
      incomplete: false,
      limits: [],
      screenshots: recorder.screenshots,
    };
    const items = buildReportPresentation(report).sections.flatMap(
      (section) => section.items,
    );
    for (const title of [
      "Images missing alt attributes",
      "Controls without accessible names",
      "Controls excluded from Tab navigation",
      "Possible text contrast problems",
    ]) {
      const item = items.find((item) => item.title === title)!;
      assert(item, title);
      assert(
        item.examples?.some((example) => example.evidenceId),
        `${title} must have evidence`,
      );
    }
    assert.equal(recorder.screenshots.length, 4);
    assert.equal(
      await page.evaluate(
        () => document.querySelectorAll("[aria-hidden=true]").length,
      ),
      0,
      "capture overlays must be removed",
    );
    const redPixels = await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let red = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i]! > 160 && pixels[i + 1]! < 110 && pixels[i + 2]! < 110)
          red++;
      return red;
    }, recorder.screenshots[0]!.dataUrl);
    assert(
      redPixels > 40,
      "a real red annotation must be present in the image",
    );
  } finally {
    await browser.close();
  }
});

test("a slow location finder is awaited and an empty page is not usable content", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setContent("<main></main>");
    assert.equal(
      (await waitForPageContent(page, performance.now() + 2600, true)).ready,
      false,
    );
    await page.setContent(
      `<main aria-busy=true></main><script>setTimeout(()=>{const main=document.querySelector('main');main.removeAttribute('aria-busy');main.innerHTML='<h1>Find a gym</h1><input placeholder="City or ZIP code">'},350)</script>`,
    );
    const state = await waitForPageContent(
      page,
      performance.now() + 5000,
      true,
    );
    assert.equal(state.ready, true);
    assert.equal(state.locationSearch, true);
  } finally {
    await browser.close();
  }
});

test("location autocomplete selects a public ZIP suggestion and blocks attempted writes", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    let writes = 0;
    await page.route("https://fixture.example/**", (route) => {
      if (route.request().method() === "POST") writes++;
      return route.fulfill({
        contentType: "text/html",
        body: `<main><h1>Locations</h1><div><div><input placeholder="City or ZIP code" oninput="fetch('/write',{method:'POST'}).catch(()=>{});document.querySelector('#suggestion').hidden=false"></div><div id=suggestion hidden onclick="document.querySelector('input').value='Columbus, OH 43215 US';document.querySelector('#results').innerHTML='<a href=/locations/campus>Campus details</a>'">Columbus, OH 43215 US</div></div><section id=results></section></main>`,
      });
    });
    await page.goto("https://fixture.example/locations");
    const action = await tryLocationSearch(page, performance.now() + 15000);
    assert.equal(action?.outcome, "passed");
    assert.match(action!.detail, /43215/);
    assert.match(action!.detail, /1 location link/);
    assert.equal(writes, 0);
  } finally {
    await browser.close();
  }
});

test("a reached URL with an empty location page remains unverified", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.route("https://fixture.example/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          new URL(route.request().url()).pathname === "/"
            ? '<main><h1>Fitness gym</h1><a href="/locations">Locations</a></main>'
            : "<main></main>",
      }),
    );
    await page.goto("https://fixture.example/");
    const result = await explorePage(
      page,
      "",
      "",
      "desktop",
      performance.now() + 8500,
      true,
      undefined,
      false,
      { focusMainActions: true },
    );
    const navigation = result.actions.find(
      (action) => action.kind === "navigation",
    );
    assert.equal(navigation?.outcome, "review");
    assert.match(navigation!.detail, /did not become usable/);
    assert(
      result.findings.some(
        (finding) => finding.evidence.contentUnverified === true,
      ),
    );
  } finally {
    await browser.close();
  }
});

test("a recovery reload does not turn the original blank click into a pass", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.route("https://fixture.example/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          new URL(route.request().url()).pathname === "/"
            ? `<main><h1>Gym</h1><a href=/locations onclick="event.preventDefault();history.pushState({},'',this.href);document.querySelector('main').innerHTML=''">Locations</a></main>`
            : '<main><h1>Find a gym</h1><input placeholder="City or ZIP code"></main>',
      }),
    );
    await page.goto("https://fixture.example/");
    const result = await explorePage(
      page,
      "",
      "",
      "desktop",
      performance.now() + 25000,
      true,
      undefined,
      false,
      { focusMainActions: true },
    );
    const navigation = result.actions.find(
      (action) => action.kind === "navigation",
    );
    assert.equal(navigation?.outcome, "review");
    assert.match(navigation!.detail, /One reload showed the page/);
    assert(
      result.findings.some(
        (finding) => finding.evidence.navigationRecovered === true,
      ),
    );
  } finally {
    await browser.close();
  }
});
