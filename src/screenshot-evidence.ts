import type { JSHandle, Locator, Page } from "playwright";
import type { ActionRecord } from "./explore.ts";
import type { Finding } from "./checks.ts";

export interface ScreenshotEvidence {
  id: string;
  dataUrl: string;
  caption: string;
}

export type RecordEvidence = (
  page: Page,
  action: ActionRecord,
  target?: Locator,
) => Promise<void>;
export type RecordFindingEvidence = (
  page: Page,
  findings: Finding[],
) => Promise<void>;

const categories = [
  ["lowContrast", "Text contrast sample"],
  ["imagesMissingAlt", "Image without an alt attribute"],
  ["controlsMissingNames", "Control without an accessible name"],
  ["keyboardExcluded", "Control excluded from Tab navigation"],
  ["images", "Image that failed to load"],
  ["fields", "Field without a detected label"],
] as const;

export function createEvidenceRecorder() {
  const screenshots: ScreenshotEvidence[] = [];
  let actionImages = 0;
  let findingImages = 0;
  const captured = new Map<string, string>();

  async function capture(page: Page, caption: string, target?: Locator, cropToTarget = false) {
    let marker: JSHandle<HTMLElement> | undefined;
    try {
      if (page.isClosed() || !/^https?:/.test(page.url()))
        return { evidenceNote: "The page was unavailable for capture." };
      let clip:
        | { x: number; y: number; width: number; height: number }
        | undefined;
      if (target) {
        if ((await target.count()) !== 1 || !(await target.isVisible()))
          return {
            evidenceNote:
              "The sampled element changed or disappeared before capture.",
          };
        await target.scrollIntoViewIfNeeded({ timeout: 700 });
        const box = await target.boundingBox({ timeout: 500 });
        if (!box)
          return {
            evidenceNote: "The sampled element had no visible position.",
          };
        const viewport = page.viewportSize();
        if (cropToTarget && viewport) {
          const width = Math.min(
            viewport.width,
            Math.max(480, box.width + 160),
          );
          const height = Math.min(
            viewport.height,
            Math.max(280, box.height + 160),
          );
          clip = {
            x: Math.max(0, Math.min(box.x - 80, viewport.width - width)),
            y: Math.max(0, Math.min(box.y - 80, viewport.height - height)),
            width,
            height,
          };
        }
        marker = await page.evaluateHandle((rect) => {
          const overlay = document.createElement("div");
          overlay.setAttribute("aria-hidden", "true");
          overlay.style.cssText = `all:initial;position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;border:3px solid #e02525;border-radius:4px;`;
          const badge = document.createElement("span");
          badge.textContent = "1";
          badge.style.cssText =
            "all:initial;position:absolute;left:0;top:0;transform:translate(-35%,-35%);box-sizing:border-box;width:24px;height:24px;border:2px solid white;border-radius:50%;background:#d71920;color:white;font:bold 13px/20px Arial;text-align:center;";
          overlay.append(badge);
          document.documentElement.append(overlay);
          return overlay;
        }, box);
      }
      const options = {
        type: "jpeg" as const,
        ...(clip ? { clip } : {}),
        scale: "css" as const,
        animations: "disabled" as const,
        timeout: 1500,
        mask: [
          page.locator("input, textarea, select, [contenteditable], iframe"),
        ],
      };
      let buffer = await page.screenshot({ ...options, quality: 45 });
      if (buffer.length > 80_000)
        buffer = await page.screenshot({ ...options, quality: 25 });
      if (buffer.length > 80_000)
        return { evidenceNote: "Screenshot exceeded the image size limit." };
      const id = `evidence-${screenshots.length + 1}`;
      const markerNote = target
        ? " Red marker 1 identifies the sampled element."
        : " Page context only; this image does not prove the cause.";
      screenshots.push({
        id,
        dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
        caption: `${caption}${markerNote} Form fields and embedded frames are masked.`,
      });
      return { evidenceId: id };
    } catch {
      return {
        evidenceNote: "A screenshot was unavailable for this observation.",
      };
    } finally {
      await marker
        ?.evaluate((node) => (node as HTMLElement).remove())
        .catch(() => {});
      await marker?.dispose().catch(() => {});
    }
  }

  const record: RecordEvidence = async (page, action, target) => {
    if (action.outcome === "passed") return;
    if (actionImages >= 4) {
      action.evidenceNote =
        "Screenshot limit reached (four action images per report).";
      return;
    }
    const result = await capture(
      page,
      `${action.label || "Action"} — ${action.outcome === "failed" ? "failed" : "unverified"}. Captured at the end of this attempt.`,
      target,
    );
    Object.assign(action, result);
    if (result.evidenceId) actionImages++;
  };

  const recordFindings: RecordFindingEvidence = async (page, findings) => {
    const scroll = await page
      .evaluate(() => ({ x: scrollX, y: scrollY }))
      .catch(() => null);
    if (!scroll) return;
    try {
      for (const finding of findings) {
        if (finding.pageUrl !== page.url()) continue;
        for (const [category, description] of categories) {
          const samples = finding.evidence[category];
          if (!Array.isArray(samples) || !samples.length) continue;
          const sample = samples.find(
            (item) => typeof item?.selector === "string",
          ) as Record<string, unknown> | undefined;
          if (!sample) continue;
          const label = String(
            sample.elementLabel || sample.text || sample.tag || description,
          ).slice(0, 100);
          const selector = String(sample.selector);
          const key = `${finding.pageUrl}:${finding.viewport.width}:${category}:${selector}`;
          const saved = captured.get(key);
          const result = saved
            ? { evidenceId: saved }
            : findingImages >= 6
              ? {
                  evidenceNote:
                    "Screenshot limit reached (six finding images per report).",
                }
              : await capture(
                  page,
                  `${description}: ${label}. ${finding.viewport.width}px viewport.`,
                  page.locator(selector),
                  true,
                );
          finding.visualEvidence ??= [];
          finding.visualEvidence.push({ category, label, ...result });
          if (!saved && result.evidenceId) {
            findingImages++;
            captured.set(key, result.evidenceId);
          }
        }
        if (finding.kind === "performance")
          finding.visualEvidence = [
            {
              category: "context",
              label: "Page at the time of the performance observation",
              evidenceNote:
                "A screenshot cannot demonstrate load timing or layout shifts; use the recorded measurements.",
            },
          ];
      }
    } finally {
      await page
        .evaluate((position) => window.scrollTo(position.x, position.y), scroll)
        .catch(() => {});
    }
  };
  return { screenshots, record, recordFindings };
}

export function interactionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/intercepts pointer events/i.test(message))
    return "Another element covered the control, so Trace could not click it.";
  if (/disappeared|no unique|exactly one/i.test(message))
    return "Trace could not uniquely identify this control after the page changed.";
  if (/Timeout|timeout/i.test(message))
    return "The action did not finish within the observation window.";
  if (/Client-side navigation/i.test(message))
    return "The intended destination and changed content were not both confirmed.";
  return "Trace could not finish this action; its intended result is unverified.";
}
