import assert from "node:assert/strict";
import test from "node:test";
import {
  basicChecks,
  basicFindings,
  browserEnvironment,
  checkWebsite,
  formatBasicReport,
  formatReportDownload,
} from "../src/basic-check.ts";
import type { Finding } from "../src/checks.ts";

test("basic report preserves evidence, separates recommendations, and includes page-level checks", () => {
  const finding = (
    kind: Finding["kind"],
    classification: Finding["classification"],
    evidence = {},
  ): Finding => ({
    kind,
    classification,
    summary: kind,
    evidence,
    pageUrl: "https://example.com/",
    viewport: { width: 1440, height: 960 },
    reproduce: ["Reload the page."],
    screenshotUrl: "/old.png",
  });
  const findings = basicFindings([
    finding("failed-resource", "review", {
      status: 404,
      url: "https://example.com/missing.js",
    }),
    finding("failed-resource", "review", { status: 403, policyBlocked: true }),
    finding("security", "recommendation", {
      header: "content-security-policy",
      value: null,
    }),
    finding("interaction", "issue"),
    finding("form-label", "review"),
    finding("mobile-overflow", "issue"),
  ]);
  assert.equal(findings.length, 5);
  assert(findings.some((item) => item.kind === "form-label"));
  assert(findings.some((item) => item.kind === "mobile-overflow"));
  assert(
    !findings.some((item) =>
      ["interaction", "broken-link"].includes(item.kind),
    ),
  );
  assert.equal(findings[0]!.classification, "issue");
  assert.equal(findings[1]!.classification, "review");
  assert(findings.every((item) => item.screenshotUrl === undefined));
  const text = formatBasicReport({
    id: "test",
    requestedUrl: "https://example.com",
    finalUrl: "https://example.com/",
    title: "Example",
    status: 200,
    connection: "https",
    capturedAt: "2026-10-07T00:00:00Z",
    durationMs: 1,
    findings,
    checked: basicChecks,
    incomplete: false,
    limits: ["Only one page."],
  });
  assert(text.includes("NEEDS ATTENTION"));
  assert(text.includes("OPTIONAL IMPROVEMENTS"));
  assert(text.includes("HTTP 404"));
  const download = formatReportDownload({
    id: "test",
    requestedUrl: "https://example.com",
    finalUrl: "https://example.com/",
    title: "Example",
    status: 200,
    connection: "https",
    capturedAt: "2026-10-07T00:00:00Z",
    durationMs: 1,
    findings,
    checked: basicChecks,
    incomplete: false,
    limits: [],
  });
  assert(download.includes("HTTP 404"));
  assert(download.includes("example.com/missing.js"));
  assert(!text.includes("/old.png"));
});

test("basic report keeps the useful result and omits noisy repeated background events", () => {
  const finding = (
    summary: string,
    classification: Finding["classification"],
    evidence: Finding["evidence"] = {},
    kind: Finding["kind"] = "failed-resource",
  ): Finding => ({
    kind,
    classification,
    summary,
    evidence,
    pageUrl: "https://example.com/",
    viewport: { width: 1440, height: 960 },
    reproduce: ["Reload the page."],
  });
  const reportFindings = [
    finding(
      "The website's Content Security Policy blocked a resource",
      "review",
      {
        url: "https://static.cloudflareinsights.com/beacon.js?token=secret",
        error: "csp",
      },
    ),
    ...Array.from({ length: 9 }, (_, index) =>
      finding("Background prefetch received HTTP 503", "review", {
        url: `https://example.com/chunk-${index}.js`,
        status: 503,
        purpose: "prefetch",
        speculationRefused: "not eligible",
      }),
    ),
    finding("6 resource request(s) were canceled by the browser", "review", {
      count: 6,
      error: "net::ERR_ABORTED",
      urls: ["https://example.com/chunk.js"],
    }),
    ...[
      "strict-transport-security",
      "content-security-policy",
      "x-content-type-options",
    ].map((header) =>
      finding(
        `Response has no ${header} header`,
        "recommendation",
        { header, value: null },
        "security",
      ),
    ),
  ];
  const text = formatBasicReport({
    id: "test",
    requestedUrl: "https://example.com/?requested=private",
    finalUrl: "https://example.com/?session=private#top",
    title: "Example Domain",
    status: 200,
    connection: "https",
    capturedAt: "2026-10-08T00:00:00Z",
    durationMs: 1,
    findings: reportFindings,
    checked: basicChecks,
    incomplete: false,
    limits: [],
  });

  assert(
    text.includes("Summary: No confirmed problems in the sampled checks."),
  );
  assert(!text.includes("static.cloudflareinsights.com"));
  assert(!text.includes("beacon.js"));
  assert(
    text.includes(
      "Consider adding STRICT-TRANSPORT-SECURITY, CONTENT-SECURITY-POLICY and X-CONTENT-TYPE-OPTIONS",
    ),
  );
  assert(!text.includes("prefetch"));
  assert(!text.includes("503"));
  assert(!text.includes("ERR_ABORTED"));
  assert(!text.includes("?token=secret"));
  assert(!text.includes("session=private"));
  assert(text.length < 1000);
});

test("basic check rejects private targets and cancellation before browser work", async () => {
  await assert.rejects(
    checkWebsite("http://169.254.169.254", new AbortController().signal),
    /public internet/,
  );
  await assert.rejects(
    checkWebsite("https://example.com", AbortSignal.abort()),
    /cancelled/,
  );
});

test("security advice distinguishes missing headers from existing settings needing review", () => {
  const finding = (evidence: Finding["evidence"]): Finding => ({
    kind: "security",
    classification: "recommendation",
    summary: "Review response protection",
    evidence,
    pageUrl: "https://example.com/",
    viewport: { width: 1440, height: 960 },
    reproduce: ["Inspect response headers."],
  });
  const text = formatBasicReport({
    id: "headers",
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    title: "Example",
    status: 200,
    connection: "https",
    capturedAt: "2026-10-26T00:00:00Z",
    durationMs: 1,
    findings: [
      finding({ header: "content-security-policy", value: null }),
      finding({ header: "strict-transport-security", value: "max-age=0" }),
      finding({ hasFrameAncestors: false, "x-frame-options": null }),
    ],
    checked: [],
    incomplete: false,
    limits: [],
  });
  assert(text.includes("Consider adding CONTENT-SECURITY-POLICY"));
  assert(text.includes("Review the STRICT-TRANSPORT-SECURITY configuration"));
  assert(text.includes("Set a framing policy"));
  assert(!text.includes("adding STRICT-TRANSPORT-SECURITY"));
});

test("basic reports distinguish prefetch rejection, recovered cancellation, CSP, and genuine resource errors", () => {
  const finding = (evidence: Finding["evidence"]): Finding => ({
    kind: "failed-resource",
    classification: "review",
    summary: "Resource failed",
    evidence,
    pageUrl: "https://example.com",
    viewport: { width: 1440, height: 960 },
    reproduce: ["Reload and inspect the network."],
  });
  const result = basicFindings(
    [
      finding({
        status: 503,
        url: "https://example.com/prefetch.js",
        speculationRefused: "prefetch refused: not eligible",
      }),
      finding({
        status: 503,
        url: "https://example.com/purpose.js",
        purpose: "prefetch",
      }),
      finding({ status: 503, url: "https://example.com/required.js" }),
      finding({
        status: 502,
        url: "https://example.com/proxy.js",
        proxyError: true,
      }),
      finding({ error: "csp", url: "https://analytics.example/beacon.js" }),
      finding({
        error: "net::ERR_ABORTED",
        url: "https://example.com/recovered.js",
      }),
      finding({
        error: "net::ERR_ABORTED",
        url: "https://example.com/canceled-1.js",
      }),
      finding({
        error: "net::ERR_ABORTED",
        url: "https://example.com/canceled-2.js",
      }),
      finding({
        error: "net::ERR_CONNECTION_FAILED",
        url: "https://example.com/connection.js",
      }),
    ],
    new Set(["https://example.com/recovered.js"]),
  );
  assert.equal(result.length, 7);
  assert.equal(
    result.filter((item) => item.classification === "issue").length,
    1,
  );
  assert.equal(
    result.find((item) => item.classification === "issue")!.evidence.url,
    "https://example.com/required.js",
  );
  assert(
    !result.some(
      (item) => item.evidence.url === "https://example.com/recovered.js",
    ),
  );
  const canceled = result.find((item) => item.evidence.count === 2)!;
  assert.deepEqual(canceled.evidence.urls, [
    "https://example.com/canceled-1.js",
    "https://example.com/canceled-2.js",
  ]);
  assert(
    result.some((item) => item.summary.includes("Content Security Policy")),
  );
  assert(
    result.some((item) => item.evidence.error === "net::ERR_CONNECTION_FAILED"),
  );
});

for (const url of ["https://example.com", "https://playwright.dev"]) {
  test(
    `basic checks load a real public website: ${url}`,
    { skip: process.env.TRACE_LIVE_TESTS !== "1", timeout: 100_000 },
    async () => {
      const report = await checkWebsite(url, AbortSignal.timeout(90_000));
      assert.equal(report.status, 200);
      assert.equal(report.connection, "https");
      assert.deepEqual(report.checked, basicChecks);
      assert(report.text.includes("TRACE — WEBSITE CHECK"));
      assert(Array.isArray(report.actions));
      assert(report.coverage);
      assert.equal(
        report.coverage.formsTested,
        report.actions.filter((action) => action.kind === "form").length,
      );
      assert.equal(
        report.coverage.searchesTested,
        report.actions.filter((action) => action.kind === "search").length,
      );
      assert(!("screenshotUrl" in report));
      assert(
        report.findings.every((finding) => finding.screenshotUrl === undefined),
      );
    },
  );
}

test("browser environment excludes service keys and cloud credentials", () => {
  assert.deepEqual(
    browserEnvironment({
      PATH: "/bin",
      HOME: "/tmp",
      TRACE_SERVICE_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      OPENAI_API_KEY: "secret",
      NODE_OPTIONS: "--require=evil",
    }),
    { PATH: "/bin", HOME: "/tmp" },
  );
});
