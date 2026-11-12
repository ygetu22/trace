import {
  createEvidenceRecorder,
  type ScreenshotEvidence,
} from "./screenshot-evidence.ts";
import type { Journey } from "./journey.ts";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { chromium, type Browser } from "playwright";
import {
  checkMobileOverflow,
  inspectPage,
  inspectPerformance,
  observePage,
  markRequestBlocked,
  type Finding,
} from "./checks.ts";
import {
  explorePage,
  type FeatureCheck,
  type ActionRecord,
} from "./explore.ts";
import { parseTarget, resolvePublicHost } from "./network-policy.ts";
import { startOutboundProxy } from "./outbound-proxy.ts";
import { TraceError } from "./errors.ts";

import {
  formatBasicReport,
  formatReportDownload,
  networkObservations,
  summarizeLimits,
  buildReportPresentation,
  type ReportPresentation,
} from "./report.ts";
export { formatBasicReport, formatReportDownload } from "./report.ts";

export const basicChecks = [
  "Page HTTP response",
  "HTTPS and certificate acceptance",
  "Page resources and visible image health",
  "Uncaught JavaScript errors during load",
  "Basic response security headers",
  "Mobile layout overflow",
  "Form labels and selected accessibility signals",
  "Search metadata",
  "Initial-load performance signals",
  "Buttons, form editing and validation, and up to three internal links",
];

interface FeatureResult {
  label: string;
  expectedText: string;
  desktopOutcome: string;
  mobileOutcome?: string;
}

export interface BasicReport {
  id: string;
  requestedUrl: string;
  finalUrl: string;
  title: string;
  status: number | null;
  connection: "http" | "https" | null;
  capturedAt: string;
  durationMs: number;
  findings: Finding[];
  checked: string[];
  incomplete: boolean;
  limits: string[];
  coverage?: {
    status?: "completed" | "restricted" | "interrupted" | "blocked";
    samplingLimited?: boolean;
    controlsTested: number;
    linksTested: number;
    formsTested?: number;
    searchesTested?: number;
    featureResult?: FeatureResult | null;
  };
  actions?: (ActionRecord & { viewport: "desktop" | "mobile" })[];
  text: string;
  downloadText?: string;
  skippedChecks?: string[];
  screenshots?: ScreenshotEvidence[];
  journey?: Journey;
  presentation?: ReportPresentation;
}

export function basicFindings(
  findings: Finding[],
  completedUrls: ReadonlySet<string> = new Set(),
): Finding[] {
  const cancellations: Finding[] = [];
  const normalized = findings.flatMap((finding) => {
    if (
      finding.kind === "failed-resource" &&
      finding.evidence.error === "net::ERR_ABORTED"
    ) {
      if (!completedUrls.has(String(finding.evidence.url)))
        cancellations.push(finding);
      return [];
    }
    return [finding];
  });
  if (cancellations.length) {
    normalized.push({
      ...cancellations[0]!,
      classification: "review",
      summary: `${cancellations.length} resource request(s) were canceled by the browser`,
      evidence: {
        count: cancellations.length,
        error: "net::ERR_ABORTED",
        urls: cancellations.map((finding) => finding.evidence.url),
      },
      explanation:
        "A canceled request is not an HTTP server error. Browsers can cancel redundant loads or background work. These requests had no completed successful replacement observed during this check; their effect on the page is unverified.",
    });
  }
  return normalized
    .filter((finding) => !["interaction", "broken-link"].includes(finding.kind))
    .map((finding) => {
      const result = { ...finding };
      delete result.screenshotUrl;
      if (
        result.kind === "failed-resource" &&
        typeof result.evidence.status === "number" &&
        !result.evidence.policyBlocked
      )
        result.classification = "issue";
      if (result.evidence.policyBlocked) {
        result.classification = "review";
        result.summary =
          "Trace blocked a resource under its public-network policy";
        result.explanation =
          "This request was rejected by Trace, so it is not a confirmed defect in the website.";
      }
      if (result.evidence.proxyError) {
        result.classification = "review";
        result.summary =
          "Trace's outbound proxy could not complete a resource request";
        result.explanation =
          "Trace generated this response after an upstream connection failed. It is not an HTTP error response received from the website.";
      }
      if (
        !result.evidence.policyBlocked &&
        !result.evidence.proxyError &&
        (result.evidence.speculationRefused ||
          /\bprefetch\b/i.test(String(result.evidence.purpose ?? "")))
      ) {
        result.classification = "review";
        result.summary = `Background prefetch received HTTP ${result.evidence.status}`;
        result.explanation =
          "This response concerns speculative background loading, not a confirmed failure of a resource used by the visible page. Review the prefetch configuration separately; the status alone does not establish a broken website feature.";
      }
      if (
        result.kind === "failed-resource" &&
        result.evidence.error === "csp"
      ) {
        result.classification = "review";
        result.summary =
          "The website's Content Security Policy blocked a resource";
        result.explanation =
          "The browser enforced the page's security policy. This may be intentional or a policy/configuration mismatch. Trace has not established an effect on the visible page; do not weaken the policy solely to remove this observation.";
      }
      if (result.kind === "access-challenge")
        result.explanation =
          "Trace received an access challenge. These observations describe that response, not the ordinary website behind it.";
      return result;
    });
}

async function createCheckPage(
  browser: Browser,
  viewport: { width: number; height: number },
  onBlocked: () => void,
) {
  const context = await browser.newContext({
    viewport,
    acceptDownloads: false,
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) {
      onBlocked();
      markRequestBlocked(route.request());
      return route.abort();
    }
    return route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => socket.close());
  const page = await context.newPage();
  context.on("page", (popup) => {
    if (popup !== page) void popup.close().catch(() => {});
  });
  page.on("dialog", (dialog) => {
    void dialog.dismiss().catch(() => {});
  });
  page.setDefaultTimeout(5000);
  return page;
}

// The browser visits untrusted sites, so it only gets the few environment variables it
// needs to start. API keys and cloud credentials in the user's shell never reach it.
export function browserEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "DISPLAY", "XDG_RUNTIME_DIR"]) {
    if (environment[name]) allowed[name] = environment[name]!;
  }
  return allowed;
}

export async function checkWebsite(
  input: unknown,
  signal: AbortSignal,
  featureCheck?: FeatureCheck,
): Promise<BasicReport> {
  if (signal.aborted) throw new TraceError("The check was cancelled.", 504);
  const target = parseTarget(input);
  await resolvePublicHost(target.hostname);
  signal.throwIfAborted();
  const started = performance.now();
  const proxy = await startOutboundProxy();
  let browser: Browser | undefined;
  const cancel = () => {
    void browser?.close().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    browser = await chromium.launch({
      channel: process.env.TRACE_BROWSER_CHANNEL || undefined,
      headless: true,
      timeout: 10_000,
      env: browserEnvironment(),
      proxy: { server: proxy.url, bypass: "<-loopback>" },
      args: [
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
    signal.throwIfAborted();
    const viewport = { width: 1440, height: 960 };
    let blocked = 0;
    let page = await createCheckPage(browser, viewport, () => blocked++);
    const observers = [observePage(page, viewport)];
    let status: number | null = null;
    let connection: BasicReport["connection"] = null;
    let title = "";
    let finalUrl = target.href;
    let findings: Finding[] = [];
    const checked: string[] = [];
    const limits = [
      "Main visitor paths: desktop and mobile sample up to two browsing controls and two forms per page. Up to three same-origin links are followed, including one follow-up page along the selected path. Identifiable same-origin GET searches use a synthetic query. Other form data is not transmitted; sign-in is excluded.",
      "Only HTTP/HTTPS public destinations are allowed. Non-read requests, WebSockets, popups, and downloads are blocked. A GET request can still have side effects on some sites.",
    ];
    const evidence = createEvidenceRecorder();
    let journey: Journey | undefined;
    const actions: NonNullable<BasicReport["actions"]> = [];
    let controlsTested = 0;
    let linksTested = 0;
    let featureResult: FeatureResult | null = null;
    let incomplete = false;
    let accessBlocked = false;
    let samplingLimited = false;
    try {
      const response = await page.goto(target.href, {
        waitUntil: "load",
        timeout: 20_000,
      });
      if (!response) throw new Error("No page response received");
      status = response.status();
      finalUrl = page.url();
      connection = new URL(finalUrl).protocol === "https:" ? "https" : "http";
      checked.push(basicChecks[0]!, basicChecks[1]!);
      if (
        !(response.headers()["content-type"] ?? "")
          .toLowerCase()
          .includes("text/html")
      ) {
        incomplete = true;
        findings.push({
          kind: "page-response",
          classification: "review",
          summary: "The URL did not return an HTML page",
          pageUrl: finalUrl,
          viewport,
          evidence: {
            status,
            contentType: response.headers()["content-type"] ?? null,
          },
          reproduce: [
            `Open ${target.href} and inspect its response content type.`,
          ],
        });
        if (status >= 400)
          findings.push({
            kind: "page-response",
            classification: "issue",
            summary: `Page returned HTTP ${status}`,
            pageUrl: finalUrl,
            viewport,
            evidence: { status },
            reproduce: [`Request ${target.href} and inspect its HTTP status.`],
          });
        limits.push(
          "The server returned a file or data response, so page resource, image, and JavaScript checks could not run.",
        );
      } else {
        // This bounded window does not imply that every asynchronous operation finished.
        await page.waitForTimeout(1_000);
        title = (await page.title()).slice(0, 300);
        findings = basicFindings(
          await inspectPage(page, status, response.headers()),
        );
        checked.push(
          ...basicChecks.slice(2, 5),
          basicChecks[6]!,
          basicChecks[7]!,
        );
        const performanceFinding = await inspectPerformance(page);
        if (performanceFinding) findings.push(performanceFinding);
        checked.push(basicChecks[8]!);
        await evidence.recordFindings(page, findings);
        accessBlocked = findings.some(
          (finding) => finding.kind === "access-challenge",
        );
        incomplete = accessBlocked;
        if (!incomplete) {
          const exploration = await explorePage(
            page,
            "",
            "",
            "desktop",
            Math.min(performance.now() + 35_000, started + 60_000),
            true,
            featureCheck,
            false,
            {
              focusMainActions: true,
              recordEvidence: evidence.record,
              recordFindingEvidence: evidence.recordFindings,
            },
          );
          journey = exploration.journey;
          findings.push(...exploration.findings);
          actions.push(
            ...exploration.actions.map((action) => ({
              ...action,
              viewport: "desktop" as const,
            })),
          );
          controlsTested = exploration.actions.filter(
            (action) => action.kind === "control",
          ).length;
          linksTested = exploration.actions.filter(
            (action) => action.kind === "navigation",
          ).length;
          const testedFeature = exploration.actions.find(
            (action) => action.kind === "feature",
          );
          if (featureCheck && testedFeature)
            featureResult = {
              label: featureCheck.label,
              expectedText: featureCheck.expectedText,
              desktopOutcome: testedFeature.outcome,
            };
          if (exploration.interrupted) {
            incomplete = true;
            limits.push(
              "Some interactions did not finish within the time budget.",
            );
          }
          samplingLimited ||= Boolean(exploration.sampleLimits?.length);
          limits.push(...(exploration.sampleLimits ?? []));
          if (exploration.skipped.length)
            limits.push(
              ...exploration.skipped.map((reason) => `Desktop: ${reason}`),
            );
          checked.push(basicChecks[9]!);
          const mobileViewport = { width: 390, height: 844 };
          observers[0]!.stop();
          await page.context().close();
          page = await createCheckPage(
            browser,
            mobileViewport,
            () => blocked++,
          );
          observers.push(observePage(page, mobileViewport));
          const mobileResponse = await page.goto(target.href, {
            waitUntil: "load",
            timeout: 20_000,
          });
          await page.waitForTimeout(500);
          if (
            !mobileResponse ||
            !(mobileResponse.headers()["content-type"] ?? "")
              .toLowerCase()
              .includes("text/html")
          ) {
            incomplete = true;
            limits.push(
              "The mobile visit did not return an HTML page, so mobile layout and control checks were skipped.",
            );
          } else {
            const mobileFindings = basicFindings(
              await inspectPage(
                page,
                mobileResponse.status(),
                mobileResponse.headers(),
              ),
            );
            await evidence.recordFindings(page, mobileFindings);
            findings.push(...mobileFindings);
            const mobileChallenge = mobileFindings.some(
              (finding) => finding.kind === "access-challenge",
            );
            if (mobileChallenge) {
              incomplete = true;
              accessBlocked = true;
              limits.push(
                "Mobile control and layout checks were skipped because the page showed an access challenge.",
              );
            } else {
              const initialOverflow = await checkMobileOverflow(
                page,
                mobileViewport,
              );
              if (initialOverflow) findings.push(initialOverflow);
              const mobileExploration = await explorePage(
                page,
                "",
                "",
                "mobile",
                performance.now() + 15_000,
                false,
                featureCheck,
                false,
                {
                  focusMainActions: true,
                  recordEvidence: evidence.record,
                  recordFindingEvidence: evidence.recordFindings,
                },
              );
              findings.push(...mobileExploration.findings);
              actions.push(
                ...mobileExploration.actions.map((action) => ({
                  ...action,
                  viewport: "mobile" as const,
                })),
              );
              controlsTested += mobileExploration.actions.filter(
                (action) => action.kind === "control",
              ).length;
              const mobileFeature = mobileExploration.actions.find(
                (action) => action.kind === "feature",
              );
              if (featureCheck && mobileFeature) {
                featureResult ??= {
                  label: featureCheck.label,
                  expectedText: featureCheck.expectedText,
                  desktopOutcome: "not tested",
                };
                featureResult.mobileOutcome = mobileFeature.outcome;
              }
              if (mobileExploration.interrupted) {
                incomplete = true;
                limits.push(
                  "Some mobile interactions did not finish within the time budget.",
                );
              }
              samplingLimited ||= Boolean(
                mobileExploration.sampleLimits?.length,
              );
              limits.push(...(mobileExploration.sampleLimits ?? []));
              limits.push(
                ...mobileExploration.skipped.map(
                  (reason) => `Mobile: ${reason}`,
                ),
              );
              const overflow = await checkMobileOverflow(page, mobileViewport);
              if (overflow) findings.push(overflow);
              checked.push(basicChecks[5]!);
            }
          }
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      incomplete = true;
      const message =
        error instanceof Error ? error.message : "Page load failed";
      const certificate = /ERR_CERT_|ERR_SSL_/i.test(message);
      findings.push({
        kind: certificate ? "security" : "page-response",
        classification: certificate ? "issue" : "review",
        summary: certificate
          ? "The browser rejected the HTTPS certificate or TLS connection"
          : "Trace could not complete some page checks",
        pageUrl: target.href,
        viewport,
        evidence: { error: message.slice(0, 2000) },
        explanation: certificate
          ? "Certificate errors were not bypassed. Review the site's certificate and HTTPS configuration."
          : "This attempt failed; it may reflect connectivity, a slow response, browser restrictions, or access protection. It does not establish that the website is broken for everyone.",
        reproduce: [
          `Open ${target.href} in a fresh browser and compare the connection result.`,
        ],
      });
      limits.push(
        "The page load did not complete, so checks without observations are untested.",
      );
      if (certificate) checked.push("HTTPS certificate acceptance");
    }
    for (const observations of observers) {
      observations.stop();
      findings.push(
        ...basicFindings(observations.findings, observations.completedUrls),
      );
      if (observations.omittedFindings) {
        limits.push(
          `${observations.omittedFindings} extra browser observations were omitted by the report limit.`,
        );
      }
    }
    if (blocked) {
      limits.push(
        `${blocked} non-read request(s) were intentionally blocked. This can affect page rendering.`,
      );
      for (const finding of findings) {
        if (finding.kind === "javascript-error") {
          finding.classification = "review";
          finding.explanation =
            "The browser recorded this error while Trace blocked non-read requests. Compare in an ordinary browser before treating it as a website defect.";
        }
      }
    }
    limits.push(
      "Page observations are time-limited. Other routes and untested user journeys may still have problems.",
    );
    limits.push(
      "Screenshots: up to four action images and six finding images, with red markers where an element is identified; form fields and embedded frames masked. Images are returned with this report, never saved to a server archive. Reloading clears the current report. Save images separately from the text download.",
    );
    limits.push(
      "Contrast samples need a known solid background; clipped text and complex compositing are skipped.",
    );
    limits.push(
      "Canceled requests and background prefetch responses can vary between visits. They are review observations, not confirmed visible-page defects.",
    );
    signal.throwIfAborted();
    const skippedChecks = limits.filter((limit) =>
      /^(Desktop|Mobile):/.test(limit),
    );
    const coverageStatus = accessBlocked
      ? ("blocked" as const)
      : incomplete
        ? ("interrupted" as const)
        : blocked
          ? ("restricted" as const)
          : ("completed" as const);
    const report = {
      id: randomUUID(),
      requestedUrl: target.href,
      finalUrl,
      title,
      status,
      connection,
      capturedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      findings,
      checked: basicChecks.filter((item) => checked.includes(item)),
      incomplete,
      limits: summarizeLimits([...limits, ...networkObservations(findings)]),
      skippedChecks,
      screenshots: evidence.screenshots,
      journey,
      actions,
      coverage: {
        status: coverageStatus,
        samplingLimited,
        controlsTested,
        linksTested,
        formsTested: actions.filter((action) => action.kind === "form").length,
        searchesTested: actions.filter((action) => action.kind === "search")
          .length,
        featureResult,
      },
    };
    return {
      ...report,
      presentation: buildReportPresentation(report),
      text: formatBasicReport(report),
      downloadText: formatReportDownload(report),
    };
  } catch (error) {
    if (signal.aborted)
      throw new TraceError(
        "The check was cancelled or exceeded its 90-second limit.",
        504,
      );
    if (error instanceof TraceError) throw error;
    throw new TraceError(
      "Trace's browser could not complete this check. Please try later.",
      503,
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    await browser?.close().catch(() => {});
    await proxy.close();
  }
}
