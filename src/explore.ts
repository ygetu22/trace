import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Locator, Page, Request, Route } from "playwright";
import {
  checkMobileOverflow,
  inspectPage,
  markRequestBlocked,
  type Finding,
} from "./checks.ts";
import { exploreSearch } from "./search-interactions.ts";
import { exploreForms } from "./form-interactions.ts";
import {
  controlCandidates,
  controlInfo,
  controlReachedState,
  findControl,
  settleControls,
} from "./control-check.ts";
import { tryLocationSearch } from "./location-search.ts";
import { waitForPageContent } from "./page-content.ts";
import { TraceError } from "./errors.ts";
import {
  planJourney,
  linkPriority,
  controlPriority,
  type JourneyPlan,
  type Journey,
} from "./journey.ts";
import {
  interactionError,
  type RecordEvidence,
  type RecordFindingEvidence,
} from "./screenshot-evidence.ts";

export interface ExplorationOptions {
  focusMainActions?: boolean;
  recordEvidence?: RecordEvidence;
  recordFindingEvidence?: RecordFindingEvidence;
  plan?: JourneyPlan;
  navigation?: { remaining: number; seen: Set<string> };
  depth?: number;
}

export interface FeatureCheck {
  label: string;
  expectedText: string;
}

export function parseFeatureCheck(input: unknown): FeatureCheck | undefined {
  if (input === undefined || input === null) return undefined;
  if (
    !input ||
    typeof input !== "object" ||
    !("label" in input) ||
    !("expectedText" in input) ||
    typeof input.label !== "string" ||
    typeof input.expectedText !== "string" ||
    !input.label.trim() ||
    !input.expectedText.trim() ||
    input.label.length > 200 ||
    input.expectedText.length > 500
  ) {
    throw new TraceError(
      "A feature check needs a control label (up to 200 characters) and expected visible text (up to 500 characters).",
      400,
    );
  }
  return { label: input.label.trim(), expectedText: input.expectedText.trim() };
}

export interface ActionRecord {
  kind: "control" | "navigation" | "feature" | "form" | "search";
  label: string;
  beforeUrl: string;
  afterUrl: string;
  outcome: "passed" | "failed" | "review";
  detail: string;
  durationMs: number;
  beforeScreenshotUrl?: string;
  afterScreenshotUrl?: string;
  evidenceId?: string;
  evidenceNote?: string;
  journeyStep?: boolean;
  expected?: string;
  observed?: string;
}

export interface Exploration {
  actions: ActionRecord[];
  findings: Finding[];
  skipped: string[];
  limited: boolean;
  interrupted?: boolean;
  sampleLimits?: string[];
  journey?: Journey;
}

// Avoid clicks whose ordinary purpose is a write, authentication, or download.
const mutatingWords =
  /\b(log\s*in|sign\s*in|sign\s*out|log\s*out|logout|login|register|subscribe|unsubscribe|delete|remove|buy|purchase|pay|checkout|cart|send|submit|save|accept|reject|consent|upload|download|install|book|reserve|donate)\b/i;

export async function explorePage(
  page: Page,
  directory: string,
  runUrl: string,
  name: string,
  deadline: number,
  navigate: boolean,
  featureCheck?: FeatureCheck,
  captureScreenshots = true,
  options: ExplorationOptions = {},
): Promise<Exploration> {
  const entryUrl = page.url();
  const origin = new URL(entryUrl).origin;
  const policySkips: string[] = [];
  const guardNavigation = async (route: Route) => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      const url = new URL(request.url());
      if (
        url.href !== entryUrl &&
        (url.origin !== origin ||
          url.search ||
          mutatingWords.test(url.pathname.replace(/[-_/]/g, " ")))
      ) {
        if (policySkips.length < 20)
          policySkips.push(
            `Blocked exploration navigation outside scope: ${url.href.slice(0, 2048)}`,
          );
        markRequestBlocked(request);
        return route.abort();
      }
    }
    return route.fallback();
  };
  await page.route("**/*", guardNavigation);
  try {
    const result = await runExploration(
      page,
      directory,
      runUrl,
      name,
      deadline,
      navigate,
      featureCheck,
      captureScreenshots,
      options,
    );
    result.skipped.push(...policySkips);
    return result;
  } finally {
    await page.unroute("**/*", guardNavigation).catch(() => {});
  }
}

async function runExploration(
  page: Page,
  directory: string,
  runUrl: string,
  name: string,
  deadline: number,
  navigate: boolean,
  featureCheck: FeatureCheck | undefined,
  captureScreenshots: boolean,
  options: ExplorationOptions = {},
): Promise<Exploration> {
  const result: Exploration = {
    actions: [],
    findings: [],
    skipped: [],
    limited: false,
    interrupted: false,
    sampleLimits: [],
  };
  const viewport = page.viewportSize()!;
  const plan = options.plan ?? (await planJourney(page));
  const navigation = options.navigation ?? {
    remaining: 3,
    seen: new Set<string>([page.url()]),
  };
  const depth = options.depth ?? 0;
  const focused = options.focusMainActions ?? false;
  const recordEvidence = options.recordEvidence;
  const entryUrl = page.url();
  let screenshotIndex = 0;
  async function screenshot() {
    if (!captureScreenshots) return undefined;
    const filename = `action-${name}-${++screenshotIndex}.png`;
    await page.screenshot({
      path: path.join(directory, filename),
      animations: "disabled",
      timeout: 2500,
    });
    return `${runUrl}/${filename}`;
  }
  function remaining() {
    if (performance.now() + 5000 > deadline) {
      result.limited = true;
      result.interrupted = true;
      return false;
    }
    return true;
  }
  function finding(
    action: ActionRecord,
    kind: Finding["kind"],
    evidence: Finding["evidence"],
  ) {
    result.findings.push({
      kind,
      classification: action.outcome === "failed" ? "issue" : "review",
      summary: action.detail,
      pageUrl: action.beforeUrl,
      viewport,
      evidence: { ...evidence, controlLabel: action.label },
      screenshotUrl: action.afterScreenshotUrl,
      reproduce: [
        `Open ${action.beforeUrl} at ${viewport.width} × ${viewport.height}.`,
        `Click “${action.label}”.`,
        action.detail,
      ],
    });
  }
  if (featureCheck && remaining()) {
    const action: ActionRecord = {
      kind: "feature",
      label: featureCheck.label,
      beforeUrl: entryUrl,
      afterUrl: entryUrl,
      outcome: "review",
      detail: "",
      durationMs: 0,
    };
    const started = performance.now();
    let blockedWrites = 0;
    const onRequest = (request: Request) => {
      if (!["GET", "HEAD"].includes(request.method())) blockedWrites++;
    };
    page.on("request", onRequest);
    try {
      const control = page
        .getByRole("button", { name: featureCheck.label, exact: true })
        .or(page.getByRole("tab", { name: featureCheck.label, exact: true }))
        .or(page.getByRole("link", { name: featureCheck.label, exact: true }));
      if ((await control.count()) !== 1)
        throw new Error(
          "The label must match exactly one button, tab, or link.",
        );
      const unsafe = await control.evaluate((element) => ({
        inForm:
          !!element.closest("form") ||
          (element instanceof HTMLButtonElement && !!element.form),
        href: element instanceof HTMLAnchorElement ? element.href : null,
        download: element.hasAttribute("download"),
        target: element.getAttribute("target"),
      }));
      if (
        unsafe.inForm ||
        unsafe.download ||
        (unsafe.target && unsafe.target !== "_self") ||
        mutatingWords.test(featureCheck.label)
      )
        throw new Error(
          "This control is excluded from read-only feature checks.",
        );
      if (unsafe.href) {
        const url = new URL(unsafe.href);
        if (
          url.origin !== new URL(entryUrl).origin ||
          url.search ||
          mutatingWords.test(url.pathname.replace(/[-_/]/g, " "))
        )
          throw new Error(
            "Feature navigation must stay on the same origin and use an eligible read-only URL.",
          );
      }
      const visibleText = () =>
        page
          .getByText(featureCheck.expectedText, { exact: false })
          .evaluateAll((elements) =>
            elements.some((element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.visibility !== "hidden" &&
                style.display !== "none"
              );
            }),
          );
      if (await visibleText())
        throw new Error(
          "Expected text is already visible before clicking; choose text that should appear as a result of the action.",
        );
      action.beforeScreenshotUrl = await screenshot();
      await control.click({ timeout: 2000, noWaitAfter: true });
      let passed = await visibleText();
      const settleDeadline = performance.now() + 3000;
      while (!passed && performance.now() < settleDeadline) {
        await page.waitForTimeout(150);
        passed = await visibleText();
      }
      action.afterUrl = page.url();
      action.afterScreenshotUrl = await screenshot();
      action.outcome = passed ? "passed" : blockedWrites ? "review" : "failed";
      action.detail = passed
        ? "The expected text became visible after clicking."
        : blockedWrites
          ? "Expected text did not appear; Trace blocked a non-read request during this feature test."
          : "Expected text did not become visible within 3 seconds.";
      if (!passed)
        finding(action, "interaction", {
          expectedText: featureCheck.expectedText,
          blockedWrites,
          observationMs: 3000,
        });
    } catch (error) {
      action.detail = interactionError(error);
      finding(action, "interaction", {
        expectedText: featureCheck.expectedText,
        blockedWrites,
      });
    } finally {
      await recordEvidence?.(page, action);
      page.removeListener("request", onRequest);
      action.durationMs = Math.round(performance.now() - started);
      result.actions.push(action);
    }
    if (remaining()) {
      try {
        await page.goto(entryUrl, { waitUntil: "load", timeout: 5000 });
      } catch {
        result.limited = true;
        result.interrupted = true;
        result.skipped.push(
          "Automatic exploration skipped: could not reload the entry page after the feature test.",
        );
        return result;
      }
    }
  }
  const locationTask =
    focused && plan.goal === "locations" && remaining()
      ? await tryLocationSearch(page, deadline, recordEvidence)
      : undefined;
  if (locationTask) {
    result.actions.push(locationTask);
    if (locationTask.outcome !== "passed")
      finding(locationTask, "interaction", {
        query: "43215",
        purpose: "location search",
      });
  }
  if (remaining() && !locationTask) {
    const search = await exploreSearch(page, deadline, recordEvidence);
    result.actions.push(...search.actions);
    result.findings.push(...search.findings);
    result.skipped.push(...search.skipped);
    result.limited ||= search.limited;
    result.interrupted ||= search.limited;
  }
  if (remaining() && !locationTask) {
    const forms = await exploreForms(page, deadline, recordEvidence, focused);
    result.actions.push(...forms.actions);
    result.findings.push(...forms.findings);
    result.skipped.push(...forms.skipped);
    result.limited ||= forms.limited;
    result.interrupted ||= forms.limited;
  }
  if (remaining()) await settleControls(page, deadline);
  const candidates = (await controlCandidates(page))
    .sort((a, b) =>
      focused ? controlPriority(b.label) - controlPriority(a.label) : 0,
    )
    .filter((info) => {
      if (locationTask) return false;
      if (focused && controlPriority(info.label) < 0) {
        result.skipped.push(
          `Skipped “${info.label}”: secondary setting or widget outside the main visitor path.`,
        );
        return false;
      }
      if (info.open || info.expanded === "true" || info.selected === "true")
        return false;
      const excluded =
        info.inForm ||
        info.disabled ||
        mutatingWords.test(info.label) ||
        (info.href && !info.href.startsWith("#"));
      const declared =
        info.details || info.expanded !== null || info.selected !== null;
      if (
        excluded ||
        (!declared &&
          !/\b(search|filter|sort|show|hide|more|less|next|previous|menu|close|open|view|expand|collapse)\b/i.test(
            info.label,
          ))
      ) {
        result.skipped.push(
          `Skipped “${info.label}”: ${excluded ? "form, disabled, navigation, or potentially state-changing action." : "its purpose needs an owner-provided expectation."}`,
        );
        return false;
      }
      return true;
    });
  let controlsTested = 0;
  for (const candidate of candidates) {
    if (!remaining()) break;
    if (controlsTested >= (focused ? 2 : 4)) {
      result.limited = true;
      result.sampleLimits!.push(
        focused
          ? "At most two main browsing controls are sampled per page."
          : "At most four eligible controls are sampled per page.",
      );
      break;
    }
    if (controlsTested) {
      try {
        await page.goto(entryUrl, {
          waitUntil: "domcontentloaded",
          timeout: 4000,
        });
        await settleControls(page, deadline);
      } catch {
        result.limited = true;
        result.interrupted = true;
        break;
      }
    }
    const control = findControl(page, candidate);
    if ((await control.count()) !== 1 || !(await control.isVisible())) {
      result.skipped.push(
        `Skipped “${candidate.label}”: no unique matching control after page changes.`,
      );
      continue;
    }
    const info = await controlInfo(control);
    if (
      info.inForm ||
      info.disabled ||
      mutatingWords.test(info.label) ||
      (info.href && !info.href.startsWith("#"))
    ) {
      result.skipped.push(
        `Skipped control “${info.label}”: form, disabled, navigation, or potentially state-changing action.`,
      );
      continue;
    }
    if (info.open || info.expanded === "true" || info.selected === "true")
      continue;
    const declared =
      info.details || info.expanded !== null || info.selected !== null;
    if (
      !declared &&
      !/\b(search|filter|sort|show|hide|more|less|next|previous|menu|close|open|view|expand|collapse)\b/i.test(
        info.label,
      )
    ) {
      result.skipped.push(
        `Skipped “${info.label}”: its purpose needs an owner-provided expectation.`,
      );
      continue;
    }
    const action: ActionRecord = {
      kind: "control",
      label: info.label,
      beforeUrl: page.url(),
      afterUrl: page.url(),
      outcome: "review",
      detail: "",
      durationMs: 0,
    };
    const started = performance.now();
    let blockedWrites = 0;
    const onRequest = (request: Request) => {
      if (!["GET", "HEAD"].includes(request.method())) blockedWrites++;
    };
    page.on("request", onRequest);
    try {
      action.beforeScreenshotUrl = await screenshot();
      const beforeContent = await page
        .locator("body")
        .innerText({ timeout: 1000 });
      await control.click({ timeout: 2000, noWaitAfter: true });
      const expected = async () => {
        if (!declared)
          return (
            (await page.locator("body").innerText({ timeout: 1000 })) !==
            beforeContent
          );
        return controlReachedState(control, info);
      };
      let passed = await expected();
      const settleDeadline = performance.now() + 1500;
      while (!passed && performance.now() < settleDeadline) {
        await page.waitForTimeout(150);
        passed = await expected();
      }
      action.outcome =
        passed && declared
          ? "passed"
          : !declared || blockedWrites || (!info.target && !info.details)
            ? "review"
            : "failed";
      const liveTarget = passed
        ? await control.getAttribute("aria-controls")
        : null;
      action.detail = !declared
        ? passed
          ? "Page content changed; the intended result still needs confirmation."
          : "No text change was observed. An expected result is needed to check this button."
        : passed
          ? info.details
            ? "Details opened."
            : liveTarget
              ? info.selected !== null
                ? "Selected the tab and showed its panel."
                : "Opened the control and showed its content."
              : "The control's announced state changed."
          : blockedWrites
            ? "Could not confirm the result because Trace blocked a request during this action."
            : !info.target && !info.details
              ? "Could not confirm that this control opened."
              : "The control did not reveal its content within 1.5 seconds.";
      action.afterScreenshotUrl = await screenshot();
      if (!passed)
        finding(action, "interaction", {
          control: info,
          blockedWrites,
          observationMs: 1500,
        });
    } catch (error) {
      action.detail = interactionError(error);
      action.outcome = "review";
      finding(action, "interaction", { control: info, blockedWrites });
    } finally {
      await recordEvidence?.(page, action, control);
      page.removeListener("request", onRequest);
      action.afterUrl = page.url();
      action.durationMs = Math.round(performance.now() - started);
      result.actions.push(action);
      controlsTested++;
    }
  }

  if (!navigate) return result;
  const links = await page.locator("a[href]").evaluateAll((elements) =>
    elements.slice(0, 300).map((element) => {
      const anchor = element as HTMLAnchorElement;
      const rect = anchor.getBoundingClientRect();
      const style = getComputedStyle(anchor);
      let hidden = style.pointerEvents === "none";
      for (
        let parent: Element | null = anchor;
        parent;
        parent = parent.parentElement
      ) {
        const parentStyle = getComputedStyle(parent);
        if (
          Number(parentStyle.opacity) === 0 ||
          parentStyle.visibility === "hidden" ||
          parent.hasAttribute("inert") ||
          parent.getAttribute("aria-hidden") === "true"
        )
          hidden = true;
      }
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const onScreen = x >= 0 && x < innerWidth && y >= 0 && y < innerHeight;
      const hit = onScreen ? document.elementFromPoint(x, y) : null;
      const obstructed =
        !hidden &&
        rect.width > 0 &&
        rect.height > 0 &&
        onScreen &&
        !!hit &&
        !anchor.contains(hit);
      if (obstructed) hidden = true;
      return {
        obstructed,
        href: anchor.href,
        label: (
          anchor.getAttribute("aria-label")?.trim() ||
          anchor.textContent?.trim() ||
          anchor.querySelector("img")?.getAttribute("alt")?.trim() ||
          anchor.getAttribute("title")?.trim() ||
          new URL(anchor.href).pathname ||
          "Home"
        ).slice(0, 120),
        prominent: !!anchor.closest(
          "main, [role=main], #page-main, header, nav",
        ),
        inMain: !!anchor.closest("main, [role=main], #page-main"),
        visible:
          !hidden &&
          rect.width > 0 &&
          rect.height > 0 &&
          getComputedStyle(anchor).visibility !== "hidden",
        download: anchor.hasAttribute("download"),
        target: anchor.target,
      };
    }),
  );
  const coveredLinks = links.filter((link) => link.obstructed).length;
  if (coveredLinks)
    result.skipped.push(
      `${coveredLinks} link(s) were covered by another element and not clicked.`,
    );
  if (focused)
    links.sort(
      (a, b) =>
        linkPriority(b.label, new URL(b.href).pathname, b.prominent, plan) +
        (b.inMain ? 25 : 0) -
        (linkPriority(a.label, new URL(a.href).pathname, a.prominent, plan) +
          (a.inMain ? 25 : 0)),
    );
  const seen = focused ? navigation.seen : new Set<string>([entryUrl]);
  let visited = 0;
  for (const link of links) {
    if (!remaining()) break;
    let url: URL;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }
    if (
      focused &&
      link.visible &&
      link.inMain &&
      link.target &&
      link.target !== "_self" &&
      url.origin === new URL(entryUrl).origin
    ) {
      result.skipped.push(
        `Skipped link “${link.label}”: opens another tab, which is outside this browsing sample.`,
      );
    }
    if (
      !link.visible ||
      link.download ||
      (link.target && link.target !== "_self") ||
      url.origin !== new URL(entryUrl).origin ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      continue;
    if (
      url.href.includes("#") ||
      url.search ||
      mutatingWords.test(`${link.label} ${url.pathname.replace(/[-_/]/g, " ")}`)
    ) {
      if (result.skipped.length < 20)
        result.skipped.push(
          `Skipped link “${link.label}”: fragment, query string, or potentially state-changing destination.`,
        );
      continue;
    }
    if (seen.has(url.href)) continue;
    if (
      focused &&
      depth > 0 &&
      (visited >= 1 ||
        !link.inMain ||
        linkPriority(link.label, url.pathname, false, plan) <= 0)
    )
      continue;
    if (focused ? navigation.remaining <= 0 : visited >= 3) {
      result.limited = true;
      result.sampleLimits!.push("At most three same-site links are sampled.");
      break;
    }
    seen.add(url.href);
    visited++;
    if (focused) navigation.remaining--;
    const action: ActionRecord = {
      kind: "navigation",
      journeyStep: focused && visited === 1,
      label: link.label,
      beforeUrl: entryUrl,
      afterUrl: entryUrl,
      outcome: "review",
      detail: "",
      durationMs: 0,
    };
    const started = performance.now();
    let clickTarget: Locator | undefined;
    try {
      if (page.url() !== entryUrl || result.actions.length) {
        await page.goto(entryUrl, {
          waitUntil: "domcontentloaded",
          timeout: 5000,
        });
        await settleControls(page, deadline);
      }
      action.beforeScreenshotUrl = await screenshot();
      const anchor = page.locator("a[href]");
      // Match the captured href, avoiding stale indices after a menu or reload.
      const index = await anchor.evaluateAll(
        (elements, target) =>
          elements.findIndex((element) => {
            const rect = element.getBoundingClientRect();
            return (
              (element as HTMLAnchorElement).href === target.href &&
              (!target.inMain ||
                !!element.closest("main, [role=main], #page-main")) &&
              rect.width > 0 &&
              rect.height > 0 &&
              getComputedStyle(element).visibility !== "hidden"
            );
          }),
        { href: url.href, inMain: focused && link.inMain },
      );
      if (index < 0)
        throw new Error("Link disappeared when the entry page was reloaded.");
      const responsePromise = page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 6000,
      });
      responsePromise.catch(() => {});
      const content = () =>
        page.evaluate(
          () =>
            (document.querySelector("main") ?? document.body)?.textContent
              ?.trim()
              .slice(0, 8000) ?? "",
        );
      const beforeContent = await content();
      clickTarget = anchor.nth(index);
      await clickTarget.click({ timeout: 2000, noWaitAfter: true });
      const response = await responsePromise;
      let clientSideNotFound = false;
      if (!response) {
        const settleDeadline = performance.now() + 1500;
        while (
          (page.url() !== url.href || (await content()) === beforeContent) &&
          performance.now() < settleDeadline
        )
          await page.waitForTimeout(150);
        if (page.url() !== url.href || (await content()) === beforeContent)
          throw new Error(
            "Client-side navigation did not reach the intended URL with changed page content.",
          );
        clientSideNotFound = await page.evaluate(() =>
          /^(?:404(?: error)?|page not found|this page could not be found)[.!\s]*$/i.test(
            document.querySelector("h1")?.textContent?.trim() ?? "",
          ),
        );
      }
      action.afterUrl = page.url();
      action.afterScreenshotUrl = await screenshot();
      if (new URL(page.url()).origin !== new URL(entryUrl).origin)
        throw new Error(
          "The link redirected outside the original origin; further inspection of that page was skipped.",
        );
      const locationFinder =
        focused &&
        /location|club|gym/i.test(`${link.label} ${url.pathname}`) &&
        !/\/(?:locations?|clubs?|gyms?)\/.+/i.test(url.pathname);
      const status = response?.status();
      let contentState =
        status !== undefined && status >= 400
          ? { ready: true }
          : await waitForPageContent(page, deadline, locationFinder);
      let recovered = false;
      let recoveryResponse: Awaited<ReturnType<Page["goto"]>> | undefined;
      let recoveryAttempted = false;
      let recoveryBlocked = false;
      if (
        focused &&
        !contentState.ready &&
        performance.now() + 10_000 < deadline
      ) {
        action.detail =
          "The click reached its URL, but main content was not usable before a recovery reload.";
        action.outcome = "review";
        recoveryAttempted = true;
        await recordEvidence?.(page, action);
        try {
          recoveryResponse = await page.goto(url.href, {
            waitUntil: "domcontentloaded",
            timeout: 5000,
          });
          contentState = await waitForPageContent(
            page,
            deadline,
            locationFinder,
          );
          recoveryBlocked =
            recoveryResponse?.headers()["x-trace-policy-blocked"] === "1" ||
            recoveryResponse?.headers()["x-trace-proxy-error"] === "1";
          recovered =
            contentState.ready &&
            !!recoveryResponse &&
            recoveryResponse.status() < 400 &&
            !recoveryBlocked &&
            new URL(page.url()).origin === url.origin;
          if (!recovered) contentState = { ready: false };
        } catch {
          /* The initial unverified result remains the result of this attempt. */
        }
      }
      action.expected = locationFinder
        ? "A usable location search or a list of locations becomes visible."
        : "The destination opens with visible main content.";
      action.observed = recovered
        ? "Usable content appeared only after one reload; the initial click was inconclusive."
        : status !== undefined && status >= 400
          ? `The destination returned HTTP ${status}.`
          : contentState.ready
            ? locationFinder
              ? "Location search or location links became visible."
              : "Main page content became visible."
            : "The URL opened, but the expected content was not ready within the observation window.";
      const traceResponse =
        recoveryBlocked ||
        response?.headers()["x-trace-policy-blocked"] === "1" ||
        response?.headers()["x-trace-proxy-error"] === "1";
      action.outcome = traceResponse
        ? "review"
        : status !== undefined && status >= 400
          ? "failed"
          : clientSideNotFound || !contentState.ready || recovered
            ? "review"
            : "passed";
      action.detail = traceResponse
        ? "Trace’s network policy or proxy prevented this destination from being checked."
        : recovered
          ? `The click reached its URL without usable main content. One reload showed the page (HTTP ${recoveryResponse?.status()}); the original click still needs review.`
          : !contentState.ready
            ? "The URL opened, but its main content or expected search did not become usable during this check."
            : response
              ? `Opened ${page.url()} (HTTP ${status}); main content became visible.`
              : clientSideNotFound
                ? `Internal link reached a page displaying a not-found message at ${page.url()}.`
                : `Opened ${page.url()} and page content changed.`;
      if (!recoveryAttempted) await recordEvidence?.(page, action);
      if (
        (status !== undefined && status >= 400) ||
        clientSideNotFound ||
        !contentState.ready ||
        recovered
      )
        finding(action, "broken-link", {
          href: url.href,
          finalUrl: page.url(),
          status: status ?? null,
          visibleNotFoundMessage: clientSideNotFound,
          policyBlocked: traceResponse,
          contentUnverified: !contentState.ready,
          navigationRecovered: recovered,
        });
      const pageFindings = traceResponse
        ? []
        : await inspectPage(
            page,
            recoveryResponse?.status() ?? status,
            recoveryResponse?.headers() ?? response?.headers(),
          );
      const overflow =
        viewport.width <= 600
          ? await checkMobileOverflow(page, viewport)
          : undefined;
      if (overflow) pageFindings.push(overflow);
      for (const item of pageFindings)
        item.screenshotUrl = action.afterScreenshotUrl;
      await options.recordFindingEvidence?.(page, pageFindings);
      result.findings.push(...pageFindings);
      action.durationMs = Math.round(performance.now() - started);
      result.actions.push(action);
      if (
        (action.outcome === "passed" || recovered) &&
        !pageFindings.some((item) => item.kind === "access-challenge") &&
        remaining()
      ) {
        const nested = await runExploration(
          page,
          directory,
          runUrl,
          `${name}-link-${visited}`,
          deadline,
          focused && depth === 0 && visited === 1 && navigation.remaining > 0,
          undefined,
          captureScreenshots,
          { ...options, plan, navigation, depth: depth + 1 },
        );
        result.actions.push(...nested.actions);
        result.findings.push(...nested.findings);
        result.skipped.push(...nested.skipped);
        result.limited ||= nested.limited;
        result.interrupted ||= nested.interrupted;
        result.sampleLimits!.push(...(nested.sampleLimits ?? []));
        if (
          focused &&
          depth === 0 &&
          visited === 1 &&
          nested.actions.some((step) => step.journeyStep)
        )
          break;
      }
    } catch (error) {
      action.afterUrl = page.url();
      action.outcome = "review";
      action.detail = interactionError(error);
      await recordEvidence?.(
        page,
        action,
        page.url() === entryUrl ? clickTarget : undefined,
      );
      finding(action, "broken-link", { href: url.href });
    } finally {
      if (!result.actions.includes(action)) {
        action.durationMs = Math.round(performance.now() - started);
        result.actions.push(action);
      }
    }
  }
  if (focused && depth === 0 && navigate) {
    const steps = result.actions.flatMap((action, index) =>
      action.journeyStep || action.kind === "search" ? [index] : [],
    );
    const journeyActions = steps.map((index) => result.actions[index]!);
    const locationSearchPassed = journeyActions.some(
      (action) => action.kind === "search" && action.outcome === "passed",
    );
    const locationDetailsPassed = journeyActions.some(
      (action) =>
        action.kind === "navigation" &&
        action.outcome === "passed" &&
        /\/(?:locations?|clubs?|gyms?)\/.+/i.test(
          new URL(action.afterUrl).pathname,
        ),
    );
    const taskComplete =
      plan.goal !== "locations" ||
      (locationSearchPassed && locationDetailsPassed);
    const passed = journeyActions.filter(
      (action) => action.outcome === "passed",
    ).length;
    const gaps =
      plan.goal === "locations"
        ? [
            !locationSearchPassed ? "Location search was not verified." : "",
            !locationDetailsPassed
              ? "An individual location page was not verified."
              : "",
          ].filter(Boolean)
        : [];
    result.journey = {
      name: plan.name,
      reason: plan.reason,
      steps,
      outcome: journeyActions.some((action) => action.outcome === "failed")
        ? "failed"
        : journeyActions.length > 1 &&
            passed === journeyActions.length &&
            taskComplete
          ? "passed"
          : "review",
      detail: journeyActions.length
        ? `${passed} of ${journeyActions.length} public steps passed. ${gaps.join(" ")} Successful submissions, sign-in, and payments remain unverified.`
        : "No eligible public browsing path was reached in this sample.",
    };
  }
  return result;
}
