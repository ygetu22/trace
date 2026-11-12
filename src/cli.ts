#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { checkWebsite, type BasicReport } from "./basic-check.ts";
import { compareReports } from "./compare.ts";
import { TraceError } from "./errors.ts";
import {
  formatTerminalComparison,
  formatTerminalReport,
  painter,
} from "./terminal-report.ts";

// Exit codes are how CI tools decide pass or fail.
const PASSED = 0;
const PROBLEMS_FOUND = 1;
const COULD_NOT_CHECK = 2;

// Same deadline the local web server gives each check.
const CHECK_TIMEOUT_MS = 90_000;

const usage = `Usage:
  webtrace check <url>                    Check one site
  webtrace diff <before-url> <after-url>  Compare two versions of a site

Trace opens the site in a real browser and tries it like a visitor would.
"diff" checks both versions and lists what stopped working.

Options:
  --json <file>  Also save the full results as JSON
  -h, --help     Show this message

Exit codes: 0 passed, 1 problems found, 2 the check could not finish`;

// Colors only for a person at a terminal, not for log files or CI.
const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = painter(color);

function countItems(report: BasicReport, kind: "issue" | "review"): number {
  const sections = (report.presentation?.sections ?? []).filter(
    (section) => section.kind === kind,
  );
  return sections.reduce((total, section) => total + section.items.length, 0);
}

// A check that was blocked or cut short must not count as a pass in CI.
function finishedCompletely(report: BasicReport): boolean {
  const status = report.coverage?.status;
  return status !== "blocked" && status !== "interrupted";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

async function checkWithDeadline(url: string, cancel: AbortSignal): Promise<BasicReport> {
  console.log(paint("dim", `Checking ${url} …`));
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(CHECK_TIMEOUT_MS)]);
  return checkWebsite(url, signal);
}

async function saveJson(path: string | undefined, data: unknown): Promise<void> {
  if (!path) return;
  await writeFile(path, JSON.stringify(data, null, 2));
  console.log(paint("dim", `Saved full results to ${path}`));
}

async function runCheck(url: string, jsonPath: string | undefined, cancel: AbortSignal) {
  const report = await checkWithDeadline(url, cancel);
  console.log(`\n${formatTerminalReport(report, color)}`);
  await saveJson(jsonPath, report);

  const problems = countItems(report, "issue");
  const counts = `${plural(problems, "problem")} · ${countItems(report, "review")} to review`;
  if (problems > 0) {
    console.log(paint(["bold", "red"], `\n✗ FAILED · ${counts}`));
    return PROBLEMS_FOUND;
  }
  if (!finishedCompletely(report)) {
    console.log(paint(["bold", "yellow"], `\n! INCOMPLETE · ${counts}`));
    return COULD_NOT_CHECK;
  }
  console.log(paint(["bold", "green"], `\n✓ PASSED · ${counts}`));
  return PASSED;
}

async function runDiff(
  beforeUrl: string,
  afterUrl: string,
  jsonPath: string | undefined,
  cancel: AbortSignal,
) {
  // One at a time, so both versions get the same machine resources and timing.
  const before = await checkWithDeadline(beforeUrl, cancel);
  const after = await checkWithDeadline(afterUrl, cancel);
  const comparison = compareReports(before, after);
  console.log(`\n${formatTerminalComparison(before, after, comparison, color)}`);
  await saveJson(jsonPath, { before, after, comparison });

  const broke = comparison.broke.length;
  const newProblems = comparison.newProblems.length;
  const counts = `${broke} stopped working · ${plural(newProblems, "new problem")}`;
  if (broke + newProblems > 0) {
    console.log(paint(["bold", "red"], `\n✗ FAILED · ${counts}`));
    return PROBLEMS_FOUND;
  }
  if (!finishedCompletely(before) || !finishedCompletely(after)) {
    console.log(paint(["bold", "yellow"], "\n! INCOMPLETE · one of the checks could not finish"));
    return COULD_NOT_CHECK;
  }
  console.log(paint(["bold", "green"], `\n✓ PASSED · nothing stopped working`));
  return PASSED;
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        json: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage}`);
    return COULD_NOT_CHECK;
  }
  if (parsed.values.help) {
    console.log(usage);
    return PASSED;
  }

  const [command, ...urls] = parsed.positionals;
  const validCheck = command === "check" && urls.length === 1;
  const validDiff = command === "diff" && urls.length === 2;
  if (!validCheck && !validDiff) {
    console.error(usage);
    return COULD_NOT_CHECK;
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    if (validCheck) return await runCheck(urls[0]!, parsed.values.json, controller.signal);
    return await runDiff(urls[0]!, urls[1]!, parsed.values.json, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      console.error("The check was stopped before it finished.");
    } else if (error instanceof Error && error.name === "TimeoutError") {
      console.error(`The check took longer than ${CHECK_TIMEOUT_MS / 1000} seconds and was stopped.`);
    } else if (error instanceof TraceError) {
      console.error(error.message);
    } else {
      console.error("The check failed unexpectedly:", error);
    }
    return COULD_NOT_CHECK;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

process.exitCode = await main();
