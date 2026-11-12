import { styleText } from "node:util";
import type { BasicReport } from "./basic-check.ts";
import { pathOf, type ActionPair, type Comparison } from "./compare.ts";

type Style = Parameters<typeof styleText>[0];
type Action = NonNullable<BasicReport["actions"]>[number];
export type Paint = (style: Style, text: string) => string;

// Colors are left out entirely when the output goes to a file or CI log.
export function painter(color: boolean): Paint {
  return (style, text) =>
    color ? styleText(style, text, { validateStream: false }) : text;
}

// The web report has its own longer text; this is the short version for terminals and CI logs.
export function formatTerminalReport(report: BasicReport, color: boolean): string {
  const paint = painter(color);
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

export function formatTerminalComparison(
  before: BasicReport,
  after: BasicReport,
  comparison: Comparison,
  color: boolean,
): string {
  const paint = painter(color);
  const lines: string[] = [
    paint("bold", "Comparing"),
    `  before  ${before.finalUrl}`,
    `  after   ${after.finalUrl}`,
  ];

  const pairLines = (icon: string, pair: ActionPair) => [
    `  ${icon} ${describeAction(pair.after)}`,
    paint("dim", `      before: ${actionResult(pair.before)}`),
    paint("dim", `      after:  ${actionResult(pair.after)}`),
  ];

  if (comparison.broke.length) {
    lines.push("", paint(["bold", "red"], `Stopped working (${comparison.broke.length})`));
    for (const pair of comparison.broke) lines.push(...pairLines(paint("red", "✗"), pair));
  }
  if (comparison.newProblems.length) {
    lines.push("", paint(["bold", "red"], `New problems (${comparison.newProblems.length})`));
    for (const item of comparison.newProblems) {
      lines.push(`  • ${item.title}`, paint("dim", `    ${item.detail}`));
    }
  }
  if (comparison.changed.length) {
    lines.push("", paint(["bold", "yellow"], `Changed (${comparison.changed.length})`));
    for (const pair of comparison.changed) lines.push(...pairLines(paint("yellow", "?"), pair));
  }
  const fixedCount = comparison.fixed.length + comparison.fixedProblems.length;
  if (fixedCount) {
    lines.push("", paint(["bold", "green"], `Fixed (${fixedCount})`));
    for (const pair of comparison.fixed) {
      lines.push(`  ${paint("green", "✓")} ${describeAction(pair.after)}`);
    }
    for (const item of comparison.fixedProblems) {
      lines.push(`  ${paint("green", "✓")} ${item.title}`);
    }
  }

  const triedOnce = comparison.onlyBefore.length + comparison.onlyAfter.length;
  lines.push(
    "",
    paint(
      "dim",
      `Same on both: ${comparison.unchangedCount} · Tried on only one version: ${triedOnce}`,
    ),
  );
  return lines.join("\n");
}

const kindNames: Record<Action["kind"], string> = {
  control: "button",
  navigation: "link",
  form: "form",
  search: "search",
  feature: "check",
};

function describeAction(action: Action): string {
  return `${action.viewport.padEnd(7)} ${kindNames[action.kind]} "${action.label}"`;
}

function actionResult(action: Action): string {
  if (action.kind === "navigation" && action.outcome === "passed") {
    return `opened ${pathOf(action.afterUrl)}`;
  }
  return action.detail;
}

function formatAction(action: Action, pageUrl: string, paint: Paint): string[] {
  const icons: Record<Action["outcome"], string> = {
    passed: paint("green", "✓"),
    failed: paint("red", "✗"),
    review: paint("yellow", "?"),
  };
  let line = `  ${icons[action.outcome]} ${describeAction(action)}`;
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
    return pathOf(url);
  } catch {
    return url;
  }
}
