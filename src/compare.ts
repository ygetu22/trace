import type { BasicReport } from "./basic-check.ts";
import type { ReportItem } from "./report.ts";

type Action = NonNullable<BasicReport["actions"]>[number];

export interface ActionPair {
  before: Action;
  after: Action;
}

export interface Comparison {
  broke: ActionPair[];
  fixed: ActionPair[];
  changed: ActionPair[];
  unchangedCount: number;
  // Exploration is sampled, so an action tried on only one side is not evidence of a change.
  onlyBefore: Action[];
  onlyAfter: Action[];
  newProblems: ReportItem[];
  fixedProblems: ReportItem[];
}

// Compares what a visitor could do on two versions of a site, such as live and preview.
// Only confirmed problems ("issue" items) count as new problems; review items like
// one-visit speed measurements vary between runs and are left out on purpose.
export function compareReports(before: BasicReport, after: BasicReport): Comparison {
  const comparison: Comparison = {
    broke: [],
    fixed: [],
    changed: [],
    unchangedCount: 0,
    onlyBefore: [],
    onlyAfter: [],
    newProblems: [],
    fixedProblems: [],
  };

  const beforeActions = actionsByKey(before);
  const afterActions = actionsByKey(after);
  for (const [key, beforeAction] of beforeActions) {
    const afterAction = afterActions.get(key);
    if (!afterAction) {
      comparison.onlyBefore.push(beforeAction);
      continue;
    }
    const pair = { before: beforeAction, after: afterAction };
    if (afterAction.outcome === "failed" && beforeAction.outcome !== "failed") {
      comparison.broke.push(pair);
    } else if (afterAction.outcome === "passed" && beforeAction.outcome !== "passed") {
      comparison.fixed.push(pair);
    } else if (afterAction.outcome !== beforeAction.outcome || destinationChanged(pair)) {
      comparison.changed.push(pair);
    } else {
      comparison.unchangedCount++;
    }
  }
  for (const [key, afterAction] of afterActions) {
    if (!beforeActions.has(key)) comparison.onlyAfter.push(afterAction);
  }

  const beforeProblems = problemsByKey(before);
  const afterProblems = problemsByKey(after);
  for (const [key, item] of afterProblems) {
    if (!beforeProblems.has(key)) comparison.newProblems.push(item);
  }
  for (const [key, item] of beforeProblems) {
    if (!afterProblems.has(key)) comparison.fixedProblems.push(item);
  }
  return comparison;
}

function actionsByKey(report: BasicReport): Map<string, Action> {
  const actions = new Map<string, Action>();
  for (const action of report.actions ?? []) {
    const key = `${action.viewport}|${action.kind}|${action.label.trim().toLowerCase()}`;
    if (!actions.has(key)) actions.set(key, action);
  }
  return actions;
}

// The two versions live on different hosts, so a link that opened "/projects" on both
// is the same destination even though the full URLs differ.
function destinationChanged({ before, after }: ActionPair): boolean {
  if (before.kind !== "navigation" || before.outcome !== "passed") return false;
  return pathOf(before.afterUrl) !== pathOf(after.afterUrl);
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function problemsByKey(report: BasicReport): Map<string, ReportItem> {
  const hosts = [report.requestedUrl, report.finalUrl].flatMap((url) => {
    try {
      return [new URL(url).host];
    } catch {
      return [];
    }
  });
  // Problem text mentions the site's own host; remove it so the same problem on
  // live and preview produces the same key.
  const withoutHosts = (text: string) =>
    hosts.reduce((result, host) => result.replaceAll(host, ""), text);

  const problems = new Map<string, ReportItem>();
  for (const section of report.presentation?.sections ?? []) {
    if (section.kind !== "issue") continue;
    for (const item of section.items) {
      problems.set(withoutHosts(`${item.title}|${item.detail}`), item);
    }
  }
  return problems;
}
