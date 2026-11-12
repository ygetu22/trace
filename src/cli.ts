#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs, styleText } from "node:util";
import { checkWebsite, type BasicReport } from "./basic-check.ts";
import { TraceError } from "./errors.ts";
import { formatTerminalReport } from "./terminal-report.ts";

// Exit codes are how CI tools decide pass or fail.
const PASSED = 0;
const PROBLEMS_FOUND = 1;
const COULD_NOT_CHECK = 2;

// Same deadline the local web server gives each check.
const CHECK_TIMEOUT_MS = 90_000;

const usage = `Usage: trace check <url> [--json <file>]

Opens the site in a real browser, tries it like a visitor would,
and prints a report.

Options:
  --json <file>  Also save the full results as JSON
  -h, --help     Show this message

Exit codes: 0 passed, 1 problems found, 2 the check could not finish`;

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

async function runCheck(url: string, jsonPath: string | undefined): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);

  // Colors only for a person at a terminal, not for log files or CI.
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const paint = (style: Parameters<typeof styleText>[0], text: string) =>
    color ? styleText(style, text, { validateStream: false }) : text;

  try {
    console.log(paint("dim", `Checking ${url} …\n`));
    const report = await checkWebsite(url, controller.signal);
    console.log(formatTerminalReport(report, color));

    if (jsonPath) {
      await writeFile(jsonPath, JSON.stringify(report, null, 2));
      console.log(paint("dim", `Saved full results to ${jsonPath}`));
    }

    const problems = countItems(report, "issue");
    const reviews = countItems(report, "review");
    const counts = `${problems} problem${problems === 1 ? "" : "s"} · ${reviews} to review`;
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
  } catch (error) {
    if (controller.signal.aborted) {
      console.error("The check was stopped before it finished.");
    } else if (error instanceof TraceError) {
      console.error(error.message);
    } else {
      console.error("The check failed unexpectedly:", error);
    }
    return COULD_NOT_CHECK;
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", cancel);
  }
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

  const [command, url, ...extra] = parsed.positionals;
  if (parsed.values.help) {
    console.log(usage);
    return PASSED;
  }
  if (command !== "check" || !url || extra.length) {
    console.error(usage);
    return COULD_NOT_CHECK;
  }
  return runCheck(url, parsed.values.json);
}

process.exitCode = await main();
