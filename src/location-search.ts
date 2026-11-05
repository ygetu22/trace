import { performance } from "node:perf_hooks";
import type { Page, Route } from "playwright";
import { markRequestBlocked } from "./checks.ts";
import type { ActionRecord } from "./explore.ts";
import type { RecordEvidence } from "./screenshot-evidence.ts";
import { readPageContent } from "./page-content.ts";

/** Try one public location autocomplete; never submit an arbitrary form. */
export async function tryLocationSearch(
  page: Page,
  deadline: number,
  recordEvidence?: RecordEvidence,
): Promise<ActionRecord | undefined> {
  const fields = page.locator(
    "input:not([type]), input[type=text], input[type=search]",
  );
  const candidates = await fields.evaluateAll((elements) =>
    elements.flatMap((element, index) => {
      const input = element as HTMLInputElement;
      const rect = input.getBoundingClientRect();
      const descriptor = `${input.placeholder} ${input.getAttribute("aria-label") ?? ""} ${input.name}`;
      return rect.width > 0 &&
        rect.height > 0 &&
        /zip|postal|postcode|address|city/i.test(descriptor) &&
        !input.closest(
          "form:has(input[type=password]),form:has(input[type=file])",
        )
        ? [index]
        : [];
    }),
  );
  if (!candidates.length || performance.now() + 7000 > deadline)
    return undefined;
  const field = fields.nth(candidates[0]!);
  const started = performance.now();
  const action: ActionRecord = {
    kind: "search",
    label: "Find a location",
    beforeUrl: page.url(),
    afterUrl: page.url(),
    outcome: "review",
    detail: "",
    durationMs: 0,
    journeyStep: true,
    expected:
      "A sample ZIP produces suggestions; a selected suggestion shows location links.",
  };
  const query = "43215";
  let blocked = 0;
  const guard = (route: Route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) {
      blocked++;
      markRequestBlocked(route.request());
      return route.abort();
    }
    return route.fallback();
  };
  await page.context().route("**/*", guard);
  await page.route("**/*", guard);
  try {
    await field.fill(query, { timeout: 1500 });
    const end = Math.min(performance.now() + 4000, deadline - 2500);
    let suggestion = "";
    while (!suggestion && performance.now() < end) {
      suggestion = await field.evaluate((element, zip) => {
        const container = element.parentElement?.parentElement;
        const matches = [
          ...(container?.querySelectorAll<HTMLElement>(
            "[role=option],li,button,div",
          ) ?? []),
        ];
        return (
          matches
            .find((candidate) => {
              const text = candidate.textContent?.trim() ?? "";
              const rect = candidate.getBoundingClientRect();
              return (
                !candidate.children.length &&
                rect.width > 0 &&
                rect.height > 0 &&
                getComputedStyle(candidate).visibility !== "hidden" &&
                text.length < 120 &&
                text.includes(zip) &&
                /[a-z]/i.test(text)
              );
            })
            ?.textContent?.trim() ?? ""
        );
      }, query);
      if (!suggestion) await page.waitForTimeout(200);
    }
    if (!suggestion) {
      action.detail = `Entered sample ZIP ${query}; no selectable address suggestion was confirmed. Search results remain unverified.`;
    } else {
      const option = field
        .locator("..")
        .locator("..")
        .getByText(suggestion, { exact: true });
      if ((await option.count()) !== 1) throw new Error("Ambiguous suggestion");
      await option.click({ timeout: 1500, noWaitAfter: true });
      const selected = await field.inputValue({ timeout: 1000 });
      let content = await readPageContent(page);
      const end = Math.min(performance.now() + 2500, deadline - 1500);
      while (!content.locationLinks && performance.now() < end) {
        await page.waitForTimeout(200);
        content = await readPageContent(page);
      }
      action.outcome =
        selected.includes(query) && content.locationLinks > 0
          ? "passed"
          : "review";
      action.detail =
        action.outcome === "passed"
          ? `Selected “${suggestion}” using sample ZIP ${query}; ${content.locationLinks} location link(s) were visible. Geographic accuracy is unverified.`
          : `Selected “${suggestion}”, but usable location results were not confirmed.`;
    }
    if (blocked && action.outcome !== "passed")
      action.detail += " Trace blocked non-read requests during this attempt.";
    action.observed = action.detail;
  } catch {
    action.detail =
      "Location search could not finish; the input or suggestion changed, was covered, or needed a blocked request.";
  } finally {
    action.afterUrl = page.url();
    await recordEvidence?.(page, action, field);
    await page.unroute("**/*", guard).catch(() => {});
    await page
      .context()
      .unroute("**/*", guard)
      .catch(() => {});
    action.durationMs = Math.round(performance.now() - started);
  }
  return action;
}
