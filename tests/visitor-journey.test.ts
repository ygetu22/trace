import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { explorePage, type ActionRecord } from "../src/explore.ts";
import {
  createEvidenceRecorder,
  interactionError,
} from "../src/screenshot-evidence.ts";
import { buildReportPresentation } from "../src/report.ts";
import type { BasicReport } from "../src/basic-check.ts";

const launch = () =>
  chromium.launch({ channel: process.env.TRACE_BROWSER_CHANNEL || undefined });

test("a gym path prioritizes locations, follows one useful step, and stays within three links", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const clicks: string[] = [];
    await page.route("https://gym.example/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      clicks.push(pathname);
      const body =
        pathname === "/"
          ? `<h1>Fitness gym</h1><footer><a href='/privacy'>Privacy</a></footer><a href='#'>United States</a><main><a href='/classes'>Classes</a><a href='/about'>About</a><a href='/locations'>Locations</a></main><button aria-label='Open accessiBe: accessibility options'>Widget</button>`
          : pathname === "/locations"
            ? `<h1>Locations</h1><main><a href='/locations/downtown'>Downtown club</a></main>`
            : pathname === "/locations/downtown"
              ? "<h1>Club temporarily unavailable</h1>"
              : "<h1>About the gym</h1>";
      return route.fulfill({
        status: pathname === "/locations/downtown" ? 503 : 200,
        contentType: "text/html",
        body,
      });
    });
    await page.goto("https://gym.example/");
    const evidence = createEvidenceRecorder();
    const result = await explorePage(
      page,
      "",
      "",
      "desktop",
      performance.now() + 30000,
      true,
      undefined,
      false,
      { focusMainActions: true, recordEvidence: evidence.record },
    );
    const navigations = result.actions.filter(
      (action) => action.kind === "navigation",
    );
    assert(navigations.length <= 3);
    assert.equal(
      navigations.length,
      2,
      "stop after the selected path instead of filling the sample with unrelated pages",
    );
    assert.deepEqual(
      navigations.slice(0, 2).map((action) => action.afterUrl),
      [
        "https://gym.example/locations",
        "https://gym.example/locations/downtown",
      ],
    );
    assert(!clicks.includes("/privacy"));
    assert(!navigations.some((action) => action.label === "United States"));
    assert(!result.actions.some((action) => /accessibe/i.test(action.label)));
    assert.equal(
      result.journey?.name,
      "Find a location and inspect its details",
    );
    assert.equal(result.journey?.outcome, "failed");
    assert.equal(result.journey?.steps.length, 2);
    const failed = navigations.find((action) => action.outcome === "failed")!;
    assert(failed.evidenceId);
    assert.equal(evidence.screenshots.length, 1);
    assert(
      evidence.screenshots[0]!.dataUrl.startsWith("data:image/jpeg;base64,"),
    );
    assert(result.journey?.detail.includes("unverified"));
  } finally {
    await browser.close();
  }
});

test("evidence masks fields and frames, captures only non-passes, and caps image count", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 400, height: 300 },
    });
    await page.route("https://evidence.example/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<style>body{margin:0}input{position:absolute;left:20px;top:20px;width:200px;height:40px}</style><input value='private value'><button style='position:absolute;top:100px'>Show results</button><iframe style='position:absolute;left:20px;top:150px;width:200px;height:60px' srcdoc='embedded data'></iframe>",
      }),
    );
    await page.goto("https://evidence.example/");
    const recorder = createEvidenceRecorder();
    const action = (outcome: ActionRecord["outcome"]): ActionRecord => ({
      kind: "control",
      label: "Show results",
      beforeUrl: page.url(),
      afterUrl: page.url(),
      outcome,
      detail: "Unverified",
      durationMs: 1,
    });
    await recorder.record(page, action("passed"));
    assert.equal(recorder.screenshots.length, 0);
    for (let i = 0; i < 4; i++)
      await recorder.record(page, action("review"), page.getByRole("button"));
    const fifth = action("failed");
    await recorder.record(page, fifth);
    assert.equal(recorder.screenshots.length, 4);
    assert.match(fifth.evidenceNote!, /limit reached/);
    assert.equal(await page.locator("[data-trace-evidence]").count(), 0);
    const pixel = await page.evaluate(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(img, 0, 0);
      return [
        ...context.getImageData(50, 40, 1, 1).data,
        ...context.getImageData(50, 180, 1, 1).data,
      ];
    }, recorder.screenshots[0]!.dataUrl);
    assert(
      pixel[0]! > 220 && pixel[1]! < 30 && pixel[2]! > 220,
      "input must be masked magenta in the image",
    );
    assert(
      pixel[4]! > 220 && pixel[5]! < 30 && pixel[6]! > 220,
      "embedded frame must be masked",
    );
  } finally {
    await browser.close();
  }
});

test("report keeps browser noise in details and splits actionable accessibility concerns", () => {
  const report: Omit<BasicReport, "text"> = {
    id: "fixture",
    requestedUrl: "https://site.example",
    finalUrl: "https://site.example/?token=private",
    title: "Fixture",
    status: 200,
    connection: "https",
    capturedAt: "",
    durationMs: 1,
    checked: [],
    incomplete: false,
    limits: [],
    findings: [
      {
        kind: "failed-resource",
        classification: "issue",
        summary: "HTTP 403 font",
        pageUrl: "https://site.example/",
        viewport: { width: 390, height: 844 },
        evidence: { status: 403 },
        reproduce: [],
      },
      {
        kind: "accessibility",
        classification: "review",
        summary: "Accessibility signals",
        pageUrl: "https://site.example/",
        viewport: { width: 390, height: 844 },
        evidence: {
          controlsMissingNames: [{ tag: "button", id: "search" }],
          lowContrast: [{ text: "Heading", ratio: 1 }],
        },
        reproduce: [],
      },
    ],
  };
  const result = buildReportPresentation(report);
  assert(!result.sections.some((section) => section.kind === "issue"));
  assert.equal(result.sections[0]!.items.length, 3);
  assert(result.sections[0]!.items.every((item) => item.nextStep));
  assert(!result.url.includes("token"));
  assert.equal(
    interactionError(
      new Error(
        "locator.click: Timeout. Call log: <div> intercepts pointer events",
      ),
    ),
    "Another element covered the control, so Trace could not click it.",
  );
});
