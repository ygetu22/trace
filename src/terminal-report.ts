import { styleText } from "node:util";
import type { BasicReport } from "./basic-check.ts";

type Style = Parameters<typeof styleText>[0];
type Action = NonNullable<BasicReport["actions"]>[number];

// The web report has its own longer text; this is the short version for terminals and CI logs.
export function formatTerminalReport(report: BasicReport, color: boolean): string {
  const paint = (style: Style, text: string) =>
    color ? styleText(style, text, { validateStream: false }) : text;
  const lines: string[] = [];

  lines.push(paint("bold", report.title || report.finalUrl));
  if (report.finalUrl !== report.requestedUrl) {
    lines.push(`  ↳ ended up at ${report.finalUrl}`);
  }
  const seconds = Math.round(report.durationMs / 1000);
  const response = report.presentation?.response ?? "No response";
  lines.push(paint("dim", `  ${response} · ${seconds}s`));

  const actions = report.actions ?? [];
  if (actions.length) {
    lines.push("", paint("bold", `What Trace tried (${actions.length})`));
    for (const action of actions) {
      lines.push(...formatAction(action, report.finalUrl, paint));
    }
  } else {
    lines.push("", "Trace found nothing it could safely click on this page.");
  }

  const sectionStyles = {
    issue: "red",
    review: "yellow",
    recommendation: "cyan",
  } as const;
  const sectionNames = {
    issue: "Problems",
    review: "Needs review",
    recommendation: "Optional",
  } as const;
  for (const section of report.presentation?.sections ?? []) {
    const heading = `${sectionNames[section.kind]} (${section.items.length})`;
    lines.push("", paint(["bold", sectionStyles[section.kind]], heading));
    for (const item of section.items) {
      lines.push(`  • ${item.title}`);
      lines.push(paint("dim", `    ${item.detail}`));
      if (section.kind === "issue" && item.nextStep) {
        lines.push(paint("dim", `    Fix: ${item.nextStep}`));
      }
    }
  }

  lines.push("");
  const status = report.coverage?.status;
  if (status === "blocked" || status === "interrupted") {
    lines.push(paint("yellow", `Trace could not finish: ${report.presentation?.completion ?? ""}`));
  } else if (report.coverage?.samplingLimited) {
    lines.push(paint("dim", "Sampling limit reached; some buttons and links were not tried."));
  }
  lines.push(paint("dim", "Not tested: sign-in, purchases, real form submissions."));
  return lines.join("\n");
}

function formatAction(
  action: Action,
  pageUrl: string,
  paint: (style: Style, text: string) => string,
): string[] {
  const icons: Record<Action["outcome"], string> = {
    passed: paint("green", "✓"),
    failed: paint("red", "✗"),
    review: paint("yellow", "?"),
  };
  const kindNames: Record<Action["kind"], string> = {
    control: "button",
    navigation: "link",
    form: "form",
    search: "search",
    feature: "check",
  };
  const viewport = action.viewport.padEnd(7);
  let line = `  ${icons[action.outcome]} ${viewport} ${kindNames[action.kind]} "${action.label}"`;
  if (action.kind === "navigation" && action.outcome === "passed") {
    line += ` → ${shortUrl(action.afterUrl, pageUrl)}`;
  }
  // Passed actions speak for themselves; the others need the reason.
  if (action.outcome === "passed") return [line];
  return [line, paint("dim", `      ${action.detail}`)];
}

// Same-site links read better as just the path, e.g. "/projects".
function shortUrl(url: string, pageUrl: string): string {
  try {
    const target = new URL(url);
    if (target.origin !== new URL(pageUrl).origin) return url;
    return `${target.pathname}${target.search}`;
  } catch {
    return url;
  }
}
