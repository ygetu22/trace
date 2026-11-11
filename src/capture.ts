import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { chromium, type Browser } from "playwright";
import { TraceError } from "./errors.ts";
import { parseTarget, resolvePublicHost } from "./network-policy.ts";
import { startOutboundProxy } from "./outbound-proxy.ts";
import { checkMobileOverflow, inspectPage, observePage, type Finding } from "./checks.ts";
import { explorePage, type ActionRecord, type FeatureCheck } from "./explore.ts";

export interface CaptureReport {
  id: string;
  requestedUrl: string;
  finalUrl: string;
  title: string;
  status: number;
  capturedAt: string;
  durationMs: number;
  viewport: { width: number; height: number };
  screenshotUrl: string;
  mobile: { viewport: { width: number; height: number }; finalUrl: string; status: number; screenshotUrl: string };
  findings: Finding[];
  omittedFindings: number;
  actions: ActionRecord[];
  coverage: {
    pagesVisited: number;
    controlsTested: number;
    linksTested: number;
    featureTests: number;
    accessBlocked: boolean;
    limited: boolean;
    skipped: string[];
    blockedRequests: { method: string; url: string }[];
  };
  security: { https: boolean; secureContext: boolean };
  traceUrls: { desktop: string; mobile: string };
}

async function createObservationPage(browser: Browser, viewport: { width: number; height: number }, blockedRequests: { method: string; url: string }[]) {
  const context = await browser.newContext({ viewport, acceptDownloads: false, serviceWorkers: "block" });
  await context.route("**/*", (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) {
      if (blockedRequests.length < 40) blockedRequests.push({ method: route.request().method(), url: route.request().url().slice(0, 2048) });
      return route.abort();
    }
    return route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => socket.close());
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  context.on("page", (popup) => { if (popup !== page) void popup.close().catch(() => {}); });
  page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
  page.setDefaultTimeout(5_000);
  return page;
}

export function browserEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "DISPLAY", "XDG_RUNTIME_DIR"]) {
    if (environment[name]) allowed[name] = environment[name]!;
  }
  return allowed;
}

export async function capturePage(
  input: unknown,
  dataDirectory: string,
  signal: AbortSignal,
  featureCheck?: FeatureCheck,
  isolation?: { proxyUrl: string },
): Promise<CaptureReport> {
  if (signal.aborted) throw new TraceError("The capture was cancelled.", 504);
  const target = parseTarget(input);
  try {
    // In the isolated worker, DNS and pinned connections belong to the external proxy.
    if (!isolation) await resolvePublicHost(target.hostname);
  } catch (error) {
    if (error instanceof TraceError) throw error;
    throw new TraceError("The website's address could not be resolved. Check the URL and try again.");
  }
  if (signal.aborted) throw new TraceError("The capture was cancelled.", 504);

  const id = randomUUID();
  const runDirectory = path.join(dataDirectory, id);
  const started = performance.now();
  const blockedRequests: { method: string; url: string }[] = [];
  const proxy = isolation ? { url: isolation.proxyUrl, close: async () => {} } : await startOutboundProxy();
  let browser: Browser | undefined;
  const closeBrowser = () => {
    void browser?.close().catch(() => {});
  };
  signal.addEventListener("abort", closeBrowser, { once: true });

  try {
    browser = await chromium.launch({
      channel: process.env.TRACE_BROWSER_CHANNEL || undefined,
      headless: true,
      chromiumSandbox: Boolean(isolation),
      env: browserEnvironment(),
      timeout: 10_000,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
      args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
    signal.throwIfAborted();
    const viewport = { width: 1440, height: 960 };
    const page = await createObservationPage(browser, viewport, blockedRequests);
    const desktopChecks = observePage(page, viewport);

    const response = await page.goto(target.href, { waitUntil: "load", timeout: 20_000 });
    if (!response) throw new TraceError("This URL did not return a web page.");
    if (!(response.headers()["content-type"] ?? "").includes("text/html")) {
      throw new TraceError("This URL returned a file or data. Enter the address of an HTML page.");
    }
    await page.evaluate(async () => {
      await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 1500))]);
    });
    await mkdir(runDirectory, { recursive: true });
    await page.screenshot({
      path: path.join(runDirectory, "screenshot.png"),
      animations: "disabled",
      timeout: 10_000,
    });
    const desktopUrl = page.url();
    const desktopTitle = await page.title();
    const security = { https: new URL(desktopUrl).protocol === "https:", secureContext: await page.evaluate(() => window.isSecureContext) };
    const desktopFindings = await inspectPage(page, response.status(), response.headers());
    for (const item of desktopFindings) item.screenshotUrl = `/runs/${id}/screenshot.png`;
    const desktopBlocked = desktopFindings.some((finding) => finding.kind === "access-challenge");
    const desktopExploration = desktopBlocked
      ? { actions: [], findings: [], skipped: ["Desktop feature testing skipped: the page appears to be an access challenge."], limited: false }
      : await explorePage(page, runDirectory, `/runs/${id}`, "desktop", Math.min(performance.now() + 25_000, started + 40_000), true, featureCheck);
    desktopChecks.stop();
    await page.context().tracing.stop({ path: path.join(runDirectory, "desktop-trace.zip") });
    await page.context().close();
    const mobileViewport = { width: 390, height: 844 };
    // A separate context avoids carrying desktop cookies and storage into mobile.
    const mobilePage = await createObservationPage(browser, mobileViewport, blockedRequests);
    const mobileChecks = observePage(mobilePage, mobileViewport);
    const mobileResponse = await mobilePage.goto(target.href, { waitUntil: "load", timeout: 20_000 });
    if (!mobileResponse || !(mobileResponse.headers()["content-type"] ?? "").includes("text/html")) {
      throw new TraceError("The mobile visit did not return an HTML page.");
    }
    await mobilePage.evaluate(async () => {
      await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 1500))]);
    });
    await mobilePage.screenshot({ path: path.join(runDirectory, "mobile.png"), animations: "disabled", timeout: 10_000 });
    const overflow = await checkMobileOverflow(mobilePage, mobileViewport);
    const mobileUrl = mobilePage.url();
    const mobileFindings = await inspectPage(mobilePage, mobileResponse.status(), mobileResponse.headers());
    if (overflow) mobileFindings.push(overflow);
    for (const item of mobileFindings) item.screenshotUrl = `/runs/${id}/mobile.png`;
    const mobileBlocked = mobileFindings.some((finding) => finding.kind === "access-challenge");
    const mobileExploration = mobileBlocked
      ? { actions: [], findings: [], skipped: ["Mobile feature testing skipped: the page appears to be an access challenge."], limited: false }
      : await explorePage(mobilePage, runDirectory, `/runs/${id}`, "mobile", Math.min(performance.now() + 15_000, started + 65_000), false, featureCheck);
    mobileChecks.stop();
    await mobilePage.context().tracing.stop({ path: path.join(runDirectory, "mobile-trace.zip") });
    const actions = [...desktopExploration.actions, ...mobileExploration.actions];
    // Identical initial-page evidence is shared; keep distinct evidence from each viewport.
    const allFindings = [
      ...desktopChecks.findings,
      ...desktopFindings,
      ...desktopExploration.findings,
      ...mobileChecks.findings,
      ...mobileFindings,
      ...mobileExploration.findings,
    ];
    const seenFindings = new Set<string>();
    const findings = allFindings.filter((item) => {
      const key = JSON.stringify([item.kind, item.summary, item.pageUrl, item.kind === "security" ? null : item.viewport, item.evidence]);
      if (seenFindings.has(key)) return false;
      seenFindings.add(key);
      return true;
    });
    const report: CaptureReport = {
      id,
      requestedUrl: target.href,
      finalUrl: desktopUrl,
      title: desktopTitle,
      status: response.status(),
      capturedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      viewport,
      screenshotUrl: `/runs/${id}/screenshot.png`,
      mobile: { viewport: mobileViewport, finalUrl: mobileUrl, status: mobileResponse.status(), screenshotUrl: `/runs/${id}/mobile.png` },
      findings,
      omittedFindings: desktopChecks.omittedFindings + mobileChecks.omittedFindings,
      actions,
      coverage: {
        pagesVisited: 2 + actions.filter((action) => action.kind === "navigation" && action.outcome !== "review").length,
        controlsTested: actions.filter((action) => action.kind === "control").length,
        linksTested: actions.filter((action) => action.kind === "navigation").length,
        featureTests: actions.filter((action) => action.kind === "feature").length,
        accessBlocked: desktopBlocked || mobileBlocked,
        limited: desktopExploration.limited || mobileExploration.limited,
        skipped: [...desktopExploration.skipped, ...mobileExploration.skipped], blockedRequests,
      },
      security,
      traceUrls: { desktop: `/runs/${id}/desktop-trace.zip`, mobile: `/runs/${id}/mobile-trace.zip` },
    };
    signal.throwIfAborted();
    await writeFile(path.join(runDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    return report;
  } catch (error) {
    await rm(runDirectory, { recursive: true, force: true });
    if (signal.aborted) throw new TraceError("The investigation stopped or exceeded its 90-second time limit.", 504);
    if (error instanceof TraceError) throw error;
    console.error("Capture failed:", error instanceof Error ? error.message : error);
    if (error instanceof Error && /ERR_CERT_|ERR_SSL_/i.test(error.message)) {
      throw new TraceError("The browser rejected the website's HTTPS certificate or TLS connection. Trace does not bypass certificate errors; check the site's certificate and HTTPS configuration.");
    }
    throw new TraceError("Trace could not capture this page. It may be unreachable, slow, or blocking automated browsers.");
  } finally {
    signal.removeEventListener("abort", closeBrowser);
    await browser?.close().catch(() => {});
    await proxy.close();
  }
}
