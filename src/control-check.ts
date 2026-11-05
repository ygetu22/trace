import { performance } from "node:perf_hooks";
import type { Locator, Page } from "playwright";

const selector = 'button, [role="button"], [role="tab"], details > summary';

export async function settleControls(
  page: Page,
  deadline: number,
): Promise<void> {
  // Enabled server-rendered buttons can appear before their client handlers attach.
  const budget = Math.min(
    1200,
    Math.max(0, deadline - performance.now() - 5000),
  );
  if (budget) await page.waitForTimeout(budget);
}

export async function controlInfo(control: Locator) {
  return control.evaluate((element) => {
    const referenced = (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
    return {
      label: (
        element.getAttribute("aria-label") ||
        referenced ||
        element.textContent ||
        element.getAttribute("title") ||
        "Unnamed control"
      )
        .trim()
        .slice(0, 120),
      role:
        element.getAttribute("role") === "tab"
          ? ("tab" as const)
          : ("button" as const),
      expanded: element.getAttribute("aria-expanded"),
      selected: element.getAttribute("aria-selected"),
      target: element.getAttribute("aria-controls"),
      details: element.tagName === "SUMMARY",
      open: element.parentElement?.hasAttribute("open"),
      inForm:
        !!element.closest("form") ||
        (element instanceof HTMLButtonElement && !!element.form),
      href: element.getAttribute("href"),
      disabled: element.matches(":disabled, [aria-disabled=true]"),
    };
  });
}

export type ControlInfo = Awaited<ReturnType<typeof controlInfo>>;

export async function controlCandidates(page: Page): Promise<ControlInfo[]> {
  const controls = page.locator(selector);
  const candidates: ControlInfo[] = [];
  for (let index = 0; index < Math.min(await controls.count(), 40); index++) {
    const control = controls.nth(index);
    if (await control.isVisible()) candidates.push(await controlInfo(control));
  }
  return candidates;
}

export function findControl(page: Page, info: ControlInfo): Locator {
  if (info.details) {
    const text = info.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return page
      .locator("details > summary")
      .filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) });
  }
  return page.getByRole(info.role, { name: info.label, exact: true });
}

export async function controlReachedState(
  control: Locator,
  initial: ControlInfo,
): Promise<boolean> {
  return control.evaluate((element, info) => {
    if (info.details)
      return element.parentElement?.hasAttribute("open") ?? false;
    const changed =
      info.selected !== null
        ? element.getAttribute("aria-selected") === "true"
        : element.getAttribute("aria-expanded") === "true";
    if (!changed) return false;
    // Some menus add aria-controls only after they open, and IDs can change on reload.
    const targets = element.getAttribute("aria-controls")?.trim();
    if (!targets) return true;
    return targets.split(/\s+/).every((id) => {
      const target = document.getElementById(id);
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    });
  }, initial);
}
