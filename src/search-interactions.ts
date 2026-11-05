import { performance } from "node:perf_hooks";
import type { Page, Route } from "playwright";
import { markRequestBlocked } from "./checks.ts";
import type { RecordEvidence } from "./screenshot-evidence.ts";
import type { ActionRecord, Exploration } from "./explore.ts";

/** Submit one explicitly identifiable, same-origin GET search with a synthetic query. */
export async function exploreSearch(
  page: Page,
  deadline: number,
  recordEvidence?: RecordEvidence,
): Promise<Exploration> {
  const result: Exploration = {
    actions: [],
    findings: [],
    skipped: [],
    limited: false,
  };
  const entry = page.url();
  const search = page
    .locator(
      "form[role=search] input:not([type=hidden]), form input[type=search]",
    )
    .first();
  if (
    !(await search.count()) ||
    !(await search.isVisible()) ||
    !(await search.isEditable())
  )
    return result;
  if (performance.now() + 12000 > deadline) {
    result.limited = true;
    return result;
  }
  const info = await search.evaluate((element) => {
    const input = element as HTMLInputElement;
    const form = input.form;
    return form
      ? {
          action: form.getAttribute("action") || location.href,
          base: document.baseURI,
          method: form.getAttribute("method") || "get",
          name: input.name,
          target: form.getAttribute("target") || "",
          type: input.type,
          otherFields: [...form.elements].some((field) => {
            if (
              field === input ||
              !(
                field instanceof HTMLInputElement ||
                field instanceof HTMLSelectElement ||
                field instanceof HTMLTextAreaElement ||
                field instanceof HTMLButtonElement
              )
            )
              return false;
            if (field.disabled || !field.name) return false;
            return true;
          }),
        }
      : null;
  });
  if (
    !info ||
    !["text", "search"].includes(info.type) ||
    info.method.toLowerCase() !== "get" ||
    !info.name ||
    info.otherFields ||
    (info.target && info.target !== "_self")
  ) {
    result.skipped.push(
      "Search submission needs a single-field, same-window GET form.",
    );
    return result;
  }
  let destination: URL;
  try {
    destination = new URL(info.action, info.base);
  } catch {
    result.skipped.push("Search action is not a valid URL.");
    return result;
  }
  if (
    destination.origin !== new URL(entry).origin ||
    /\b(delete|remove|logout|signout|checkout|pay|subscribe|send|save)\b/i.test(
      destination.pathname.replace(/[-_/]/g, " "),
    )
  ) {
    result.skipped.push("Search destination is outside the read-only scope.");
    return result;
  }
  const started = performance.now();
  const action: ActionRecord = {
    kind: "search",
    label: "Search",
    beforeUrl: entry,
    afterUrl: entry,
    outcome: "review",
    detail: "",
    durationMs: 0,
  };
  let blocked = 0;
  const guard = (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["GET", "HEAD"].includes(request.method())) {
      blocked++;
      markRequestBlocked(request);
      return route.abort();
    }
    if (request.isNavigationRequest()) {
      if (
        request.frame() === page.mainFrame() &&
        url.origin === destination.origin &&
        url.pathname === destination.pathname &&
        [...url.searchParams].length === 1 &&
        url.searchParams.get(info.name) === "trace"
      ) {
        // This narrow exception allows the search query through the exploration navigation guard.
        return route.continue();
      }
      blocked++;
      markRequestBlocked(request);
      return route.abort();
    }
    return route.fallback();
  };
  await page.route("**/*", guard);
  try {
    const before = await page.locator("body").innerText({ timeout: 1000 });
    await search.fill("trace", { timeout: 1500 });
    const navigation = page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 2500 })
      .catch(() => null);
    await search.press("Enter", { timeout: 1500, noWaitAfter: true });
    const response = await navigation;
    await page.waitForTimeout(250);
    action.afterUrl = page.url();
    const sameOrigin = new URL(action.afterUrl).origin === destination.origin;
    const changed =
      sameOrigin &&
      (await page.locator("body").innerText({ timeout: 1000 })) !== before;
    if (blocked || !sameOrigin)
      action.detail =
        "Search could not be verified because its requests or destination were outside Trace's scope.";
    else if (
      response &&
      (response.headers()["x-trace-policy-blocked"] === "1" ||
        response.headers()["x-trace-proxy-error"] === "1")
    ) {
      action.detail =
        "Trace's network policy or proxy prevented the search response from being checked.";
    } else if (response && response.status() >= 400) {
      action.outcome = "failed";
      action.detail = `Searching for “trace” returned HTTP ${response.status()}.`;
    } else {
      action.detail = changed
        ? "Searching for “trace” changed the visible page. Result relevance still needs an owner-provided expectation."
        : "Search was attempted, but no visible result change was confirmed. This alone does not establish a broken search.";
    }
  } catch {
    action.detail = "Search could not complete within the observation window.";
  } finally {
    await recordEvidence?.(page, action, search);
    await page.unroute("**/*", guard).catch(() => {});
    action.durationMs = Math.round(performance.now() - started);
    result.actions.push(action);
    try {
      await page.goto(entry, { waitUntil: "domcontentloaded", timeout: 4000 });
    } catch {
      result.limited = true;
    }
  }
  if (action.outcome === "failed")
    result.findings.push({
      kind: "interaction",
      classification: "issue",
      summary: action.detail,
      pageUrl: entry,
      viewport: page.viewportSize()!,
      evidence: { controlLabel: "Search", query: "trace" },
      reproduce: [
        `Open ${entry}.`,
        "Enter trace in the search field and press Enter.",
        action.detail,
      ],
    });
  return result;
}
