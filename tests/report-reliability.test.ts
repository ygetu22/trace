import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { inspectPage, type Finding } from "../src/checks.ts";
import { explorePage } from "../src/explore.ts";
import {
  formatBasicReport,
  formatReportDownload,
  summarizeLimits,
} from "../src/report.ts";
import type { BasicReport } from "../src/basic-check.ts";

function report(overrides: Partial<BasicReport> = {}): BasicReport {
  return {
    id: "report-fixture",
    requestedUrl: "https://fixture.example/",
    finalUrl: "https://fixture.example/",
    title: "Fixture",
    status: 200,
    connection: "https",
    capturedAt: "2026-10-26T00:00:00Z",
    durationMs: 1,
    findings: [],
    checked: [],
    incomplete: false,
    limits: [],
    actions: [],
    text: "",
    ...overrides,
  };
}

function csp(url: string): Finding {
  return {
    kind: "failed-resource",
    classification: "review",
    summary: "Policy blocked a resource",
    evidence: { error: "csp", url },
    pageUrl: "https://fixture.example/",
    viewport: { width: 390, height: 844 },
    reproduce: [],
  };
}

test("repeated CSP events count distinct URLs and stay out of the main summary", () => {
  const fixture = report({
    findings: Array.from({ length: 8 }, () =>
      csp("https://analytics.example/beacon.js?private=secret"),
    ),
  });
  assert(!formatBasicReport(fixture).includes("blocked"));
  const download = formatReportDownload(fixture);
  assert(download.includes("blocked 1 distinct resource"));
  assert(!download.includes("8 resources"));
  assert(!download.includes("private=secret"));
});

test("main report is short while download preserves actions and grouped coverage", () => {
  const limits = [
    "Desktop: Skipped “Theme”: its purpose needs an owner-provided expectation.",
    "Mobile: Skipped “Theme”: its purpose needs an owner-provided expectation.",
    "Desktop: Skipped “Slide 1”: its purpose needs an owner-provided expectation.",
  ];
  const grouped = summarizeLimits(limits);
  assert.equal(grouped.length, 1);
  assert.match(grouped[0]!, /2 distinct controls/);
  const fixture = report({
    limits: grouped,
    coverage: {
      status: "completed",
      samplingLimited: true,
      controlsTested: 1,
      linksTested: 3,
    },
    actions: [
      {
        kind: "navigation",
        label: "Resume",
        viewport: "desktop",
        beforeUrl: "https://fixture.example/?secret=value",
        afterUrl: "https://fixture.example/resume",
        outcome: "passed",
        detail: "Opened the resume page.",
        durationMs: 1,
      },
    ],
  });
  const text = formatBasicReport(fixture);
  assert(text.length < 500);
  assert(!text.includes("Resume"));
  assert(text.includes("Sample completed. Sampling limits reached."));
  const download = formatReportDownload(fixture);
  assert(download.includes("Resume"));
  assert(download.includes("2 distinct controls"));
  assert(!download.includes("secret=value"));
});

test("interrupted and blocked checks never claim the sample completed", () => {
  for (const status of ["interrupted", "blocked"] as const) {
    const text = formatBasicReport(
      report({
        incomplete: true,
        coverage: { status, controlsTested: 0, linksTested: 0 },
      }),
    );
    assert(!text.includes("Sample completed"));
    assert(
      text.includes(status === "blocked" ? "Access blocked" : "Stopped early"),
    );
  }
});

test("contrast skips clipped, composed, and unknown backgrounds but keeps a real solid-color problem", async () => {
  const browser = await chromium.launch({
    channel: process.env.TRACE_BROWSER_CHANNEL || undefined,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.goto("about:blank");
    const contrast = async (html: string) => {
      await page.setContent(html);
      // inspectPage needs a public-looking page URL; navigation is fulfilled locally, not sent to the internet.
      const findings = await inspectPage(page, 200, {});
      return findings.flatMap(
        (finding) =>
          (finding.evidence.lowContrast ?? []) as {
            text: string;
            background: string;
          }[],
      );
    };
    await page.route("https://fixture.example/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>Fixture</p>" }),
    );
    await page.goto("https://fixture.example/");
    assert.deepEqual(
      await contrast('<p style="color:#eee">Unknown canvas background</p>'),
      [],
    );
    const samples = await contrast(`<body style="background:white">
      <a style="position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden;color:white">Skip to main content</a>
      <div style="clip-path:inset(50%)"><p style="color:white;background:white">Clipped ancestor</p></div>
      <div style="background:linear-gradient(black,white)"><p style="color:#ddd">Gradient background</p></div>
      <div style="opacity:.5"><p style="color:#ddd;background:white">Translucent ancestor</p></div>
      <p style="color:#ccc">Actual faint text</p>
      </body>`);
    assert.equal(samples.length, 1);
    assert.equal(samples[0]!.text, "Actual faint text");
    assert.equal(samples[0]!.background, "rgb(255, 255, 255)");
    assert.deepEqual(
      await contrast(
        '<body style="background:white"><canvas style="position:absolute;inset:0;width:100%;height:100%"></canvas><p style="color:white">Text over a canvas</p></body>',
      ),
      [],
    );
  } finally {
    await browser.close();
  }
});

test(
  "a delayed menu with changing DOM order and dynamically added target is checked",
  { timeout: 15_000 },
  async () => {
    const browser = await chromium.launch({
      channel: process.env.TRACE_BROWSER_CHANNEL || undefined,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      let visits = 0;
      await page.route("https://fixture.example/**", (route) => {
        const first = `<button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Show first</button>`;
        const menu = `<button aria-label="Toggle List Menu" aria-expanded="false">Menu</button>`;
        const buttons = ++visits % 2 ? first + menu : menu + first;
        return route.fulfill({
          contentType: "text/html",
          body: `
      ${buttons}<script>
      setTimeout(() => {
        const menu = document.querySelector('[aria-label="Toggle List Menu"]');
        const other = document.createElement('button'); other.textContent='Unknown action'; document.body.prepend(other);
        menu.onclick = () => { menu.setAttribute('aria-expanded','true'); menu.setAttribute('aria-controls','new-menu-id');
          const panel = document.createElement('div'); panel.id='new-menu-id'; panel.textContent='Menu content'; document.body.append(panel); };
      }, 650);
      </script>`,
        });
      });
      await page.goto("https://fixture.example/");
      const result = await explorePage(
        page,
        "",
        "",
        "mobile",
        performance.now() + 10_000,
        false,
        undefined,
        false,
      );
      const menu = result.actions.find(
        (action) => action.label === "Toggle List Menu",
      );
      assert.equal(
        result.actions.find((action) => action.label === "Show first")?.outcome,
        "passed",
      );
      assert.equal(menu?.outcome, "passed");
      assert.equal(result.interrupted, false);
      assert.equal(await page.locator("#new-menu-id").isVisible(), true);
    } finally {
      await browser.close();
    }
  },
);

test(
  "three eligible links plus excluded links do not falsely mark exploration interrupted",
  { timeout: 20_000 },
  async () => {
    const browser = await chromium.launch({
      channel: process.env.TRACE_BROWSER_CHANNEL || undefined,
    });
    try {
      const page = await browser.newPage();
      await page.route("https://fixture.example/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            new URL(route.request().url()).pathname === "/"
              ? '<a href="/one">One</a><a href="/two">Two</a><a href="/three">Three</a><a href="https://outside.example/">External</a><a href="/logout">Log out</a>'
              : "<main>Destination</main>",
        }),
      );
      await page.goto("https://fixture.example/");
      const result = await explorePage(
        page,
        "",
        "",
        "desktop",
        performance.now() + 15_000,
        true,
        undefined,
        false,
      );
      assert.equal(
        result.actions.filter((action) => action.kind === "navigation").length,
        3,
      );
      assert.equal(result.interrupted, false);
      assert.equal(result.limited, false);
    } finally {
      await browser.close();
    }
  },
);

test(
  "SPA links are settled again after returning to the entry page",
  { timeout: 20_000 },
  async () => {
    const browser = await chromium.launch({
      channel: process.env.TRACE_BROWSER_CHANNEL || undefined,
    });
    try {
      const page = await browser.newPage();
      await page.route("https://fixture.example/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `
      <main>Home content</main><a href="/one" onclick="event.preventDefault()">One</a><a href="/two" onclick="event.preventDefault()">Two</a>
      <script>setTimeout(() => { for (const link of document.querySelectorAll('a')) link.onclick = event => {
        event.preventDefault(); history.pushState({}, '', link.getAttribute('href'));
        document.querySelector('main').textContent = 'Content for ' + link.getAttribute('href');
      }; }, 650);</script>`,
        }),
      );
      await page.goto("https://fixture.example/");
      const result = await explorePage(
        page,
        "",
        "",
        "desktop",
        performance.now() + 15_000,
        true,
        undefined,
        false,
      );
      const links = result.actions.filter(
        (action) => action.kind === "navigation",
      );
      assert.equal(links.length, 2);
      assert(
        links.every((action) => action.outcome === "passed"),
        JSON.stringify(links),
      );
    } finally {
      await browser.close();
    }
  },
);
