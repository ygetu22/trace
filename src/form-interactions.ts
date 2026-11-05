import { performance } from "node:perf_hooks";
import type { Page, Route } from "playwright";
import { markRequestBlocked, setInteractionRestricted } from "./checks.ts";
import type { RecordEvidence } from "./screenshot-evidence.ts";
import type { ActionRecord, Exploration } from "./explore.ts";

/** Exercise client-side form behavior without transmitting entered data. */
export async function exploreForms(
  page: Page,
  deadline: number,
  recordEvidence?: RecordEvidence,
  focusMainActions = false,
): Promise<Exploration> {
  const result: Exploration = {
    actions: [],
    findings: [],
    skipped: [],
    limited: false,
  };
  const entry = page.url();
  const forms = page.locator("form");
  const count = Math.min(await forms.count(), 2);
  for (let index = 0; index < count; index++) {
    if (performance.now() + 10000 > deadline) {
      result.limited = true;
      break;
    }
    if (index) {
      try {
        await page.goto(entry, {
          waitUntil: "domcontentloaded",
          timeout: 4000,
        });
      } catch {
        result.limited = true;
        break;
      }
    }
    const form = forms.nth(index);
    if (!(await form.isVisible())) continue;
    const info = await form.evaluate((element) => ({
      label: (
        element.getAttribute("aria-label") ||
        element.getAttribute("name") ||
        element.id ||
        "Form"
      ).slice(0, 100),
      sensitive: !!element.querySelector(
        'input[type=password], input[type=file], input[autocomplete^="cc-"], input[autocomplete="one-time-code"]',
      ),
    }));
    if (focusMainActions && /newsletter|subscribe|mailing/i.test(info.label)) {
      result.skipped.push(`${info.label}: secondary newsletter form.`);
      continue;
    }
    if (info.sensitive) {
      result.skipped.push(
        `${info.label}: authentication, payment, or upload fields.`,
      );
      continue;
    }
    const action: ActionRecord = {
      kind: "form",
      label: info.label,
      beforeUrl: entry,
      afterUrl: entry,
      outcome: "review",
      detail: "",
      durationMs: 0,
    };
    const started = performance.now();
    let blockedRequests = 0;
    // Block GET as well as POST: input/change handlers can submit in the background.
    const block = (route: Route) => {
      blockedRequests++;
      markRequestBlocked(route.request());
      return route.abort();
    };
    await page.context().route("**/*", block);
    await page.route("**/*", block);
    setInteractionRestricted(page, true);
    try {
      const observations: string[] = [];
      const field = form
        .locator(
          "input[type=text], input[type=email], input[type=search], input:not([type]), textarea",
        )
        .first();
      if (
        (await field.count()) &&
        (await field.isVisible()) &&
        (await field.isEditable())
      ) {
        const type = await field.getAttribute("type");
        await field.fill(
          type === "email" ? "trace@example.invalid" : "Trace sample",
          { timeout: 1500 },
        );
        await field.press("Tab", { timeout: 1000 });
        if (
          (await field.inputValue()) ===
          (type === "email" ? "trace@example.invalid" : "Trace sample")
        )
          observations.push("text input retained the sample value");
      }
      const select = form.locator("select:not([multiple]):enabled").first();
      if (
        performance.now() + 7000 < deadline &&
        (await select.count()) &&
        (await select.isVisible())
      ) {
        const option = await select.evaluate((element) => {
          const select = element as HTMLSelectElement;
          return [...select.options].find(
            (option) =>
              !option.disabled && option.value && option.value !== select.value,
          )?.value;
        });
        if (option !== undefined) {
          await select.selectOption(option, { timeout: 1500 });
          if ((await select.inputValue()) === option)
            observations.push("dropdown selection changed");
        }
      }
      const checkbox = form.locator("input[type=checkbox]:enabled").first();
      if (
        performance.now() + 7000 < deadline &&
        (await checkbox.count()) &&
        (await checkbox.isVisible())
      ) {
        const checked = await checkbox.isChecked();
        await checkbox.setChecked(!checked, { timeout: 1500 });
        if ((await checkbox.isChecked()) !== checked)
          observations.push("checkbox toggled");
      }
      const required = form
        .locator(
          "input[required][type=text], input[required][type=email], input[required][type=search], input[required]:not([type]), textarea[required]",
        )
        .first();
      const submit = form
        .locator("button[type=submit], button:not([type]), input[type=submit]")
        .first();
      if (
        performance.now() + 7000 < deadline &&
        (await required.count()) &&
        (await required.isVisible()) &&
        (await required.isEditable()) &&
        (await submit.count()) &&
        (await submit.isVisible())
      ) {
        await required.fill("", { timeout: 1500 });
        await form.evaluate((element) => {
          element.setAttribute("data-trace-invalid", "0");
          element.addEventListener(
            "invalid",
            () => element.setAttribute("data-trace-invalid", "1"),
            { capture: true, once: true },
          );
        });
        await submit.click({ timeout: 1500, noWaitAfter: true });
        if (
          (await form.getAttribute("data-trace-invalid", { timeout: 1000 })) ===
          "1"
        )
          observations.push("browser rejected an empty required field");
        else observations.push("required-field rejection was not confirmed");
      }
      action.outcome = "review";
      action.detail = observations.length
        ? `${observations.join("; ")}. Server submission was not tested.`
        : "No supported editable fields were available.";
      // Successful editing is evidence of editing only, not a working business workflow.
      if (
        observations.length &&
        !observations.some((item) => item.includes("not confirmed"))
      )
        action.outcome = "passed";
      if (blockedRequests)
        action.detail +=
          " Network requests were blocked during this form check.";
    } catch {
      action.detail =
        "Form interaction could not finish; the field changed, was obstructed, or navigation was blocked. Submission is unverified.";
    } finally {
      action.afterUrl = page.url();
      await recordEvidence?.(page, action, form);
      // Destroy the document before releasing the guard, including pending debounce timers.
      await page
        .goto("about:blank", { timeout: 2000 })
        .catch(() => page.close());
      await page.unroute("**/*", block).catch(() => {});
      await page
        .context()
        .unroute("**/*", block)
        .catch(() => {});
      setInteractionRestricted(page, false);
      action.durationMs = Math.round(performance.now() - started);
      result.actions.push(action);
    }
    if (action.outcome === "review")
      result.findings.push({
        kind: "interaction",
        classification: "review",
        summary: action.detail,
        pageUrl: entry,
        viewport: page.viewportSize()!,
        evidence: { controlLabel: info.label, blockedRequests },
        reproduce: [
          `Open ${entry}.`,
          `Edit fields in “${info.label}”, then try the submit button with a required field empty.`,
          action.detail,
        ],
      });
  }
  if (result.actions.length) {
    try {
      await page.goto(entry, { waitUntil: "domcontentloaded", timeout: 4000 });
    } catch {
      result.limited = true;
    }
  }
  return result;
}
