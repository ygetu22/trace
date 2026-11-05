import { performance } from "node:perf_hooks";
import type { Page } from "playwright";

export async function readPageContent(page: Page) {
  return page.evaluate(() => {
    const root =
      document.querySelector<HTMLElement>('main, [role="main"], #page-main') ??
      document.body;
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity) > 0
      );
    };
    const fallbackText = [
      ...root.querySelectorAll<HTMLElement>(
        "h1,h2,h3,p,article,section,label,a,li",
      ),
    ]
      .filter(
        (element) =>
          visible(element) &&
          !element.closest("header,nav,footer,[role=navigation]"),
      )
      .slice(0, 120)
      .map((element) => element.innerText?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
      .slice(0, 8000);
    const text =
      root === document.body
        ? fallbackText
        : root.innerText.trim().slice(0, 8000);
    const search = [
      ...root.querySelectorAll<HTMLInputElement>(
        "input:not([type]),input[type=text],input[type=search]",
      ),
    ].some(
      (element) =>
        visible(element) &&
        /zip|postal|postcode|address|city/i.test(
          `${element.placeholder} ${element.getAttribute("aria-label") ?? ""} ${element.name}`,
        ),
    );
    const locationLinks = [
      ...root.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ].filter(
      (element) =>
        visible(element) &&
        /\/(?:locations?|clubs?|gyms?)\/.+/i.test(element.pathname),
    ).length;
    return {
      text,
      locationSearch: search,
      locationLinks,
      hasContent: text.length >= 3 || search,
      loading:
        root.getAttribute("aria-busy") === "true" ||
        /^(?:loading|please wait)[.\s]*$/i.test(text),
    };
  });
}

export async function waitForPageContent(
  page: Page,
  deadline: number,
  locationFinder = false,
) {
  const end = Math.min(
    performance.now() + (locationFinder ? 8000 : 5000),
    deadline - 2500,
  );
  let state = await readPageContent(page);
  while (
    (!state.hasContent ||
      state.loading ||
      (locationFinder && !state.locationSearch && !state.locationLinks)) &&
    performance.now() < end
  ) {
    await page.waitForTimeout(200);
    state = await readPageContent(page);
  }
  return {
    ...state,
    ready:
      !state.loading &&
      state.hasContent &&
      (!locationFinder || state.locationSearch || state.locationLinks > 0),
  };
}
