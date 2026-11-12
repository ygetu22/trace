import assert from "node:assert/strict";
import test from "node:test";
import type { BasicReport } from "../src/basic-check.ts";
import { formatTerminalReport } from "../src/terminal-report.ts";

function report(overrides: Partial<BasicReport> = {}): BasicReport {
  return {
    id: "report-fixture",
    requestedUrl: "https://fixture.example/",
    finalUrl: "https://fixture.example/",
    title: "Fixture",
    status: 200,
    connection: "https",
    capturedAt: "2026-11-11T00:00:00Z",
    durationMs: 21_400,
    findings: [],
    checked: [],
    incomplete: false,
    limits: [],
    actions: [],
    text: "",
    ...overrides,
  };
}

const navigation = {
  kind: "navigation" as const,
  beforeUrl: "https://fixture.example/",
  durationMs: 1,
  viewport: "desktop" as const,
};

test("terminal report shows where a redirect ended up", () => {
  const text = formatTerminalReport(
    report({ finalUrl: "https://www.fixture.example/maintenance" }),
    false,
  );
  assert.match(text, /ended up at https:\/\/www\.fixture\.example\/maintenance/);
  assert.doesNotMatch(
    formatTerminalReport(report(), false),
    /ended up at/,
    "no redirect line when the URL did not change",
  );
});

test("terminal report lists what was tried, with reasons only for non-passing actions", () => {
  const text = formatTerminalReport(
    report({
      actions: [
        {
          ...navigation,
          label: "projects",
          afterUrl: "https://fixture.example/projects",
          outcome: "passed",
          detail: "Opened the projects page.",
        },
        {
          ...navigation,
          label: "contact",
          afterUrl: "https://fixture.example/404",
          outcome: "failed",
          detail: "The link opened a page that returned HTTP 404.",
        },
      ],
    }),
    false,
  );
  assert.match(text, /What Trace tried \(2\)/);
  assert.match(text, /✓ desktop link "projects" → \/projects/);
  assert.match(text, /✗ desktop link "contact"\n {6}The link opened a page that returned HTTP 404\./);
  assert.doesNotMatch(text, /Opened the projects page/);
});

test("terminal report has no color codes when color is off", () => {
  const text = formatTerminalReport(report(), false);
  assert.doesNotMatch(text, /\u001b\[/);
});

test("terminal report shows a button tried on several pages once, with a page count", () => {
  const searchButton = {
    kind: "control" as const,
    viewport: "desktop" as const,
    label: "Search",
    outcome: "review" as const,
    detail: "Page content changed; the intended result still needs confirmation.",
    durationMs: 1,
  };
  const text = formatTerminalReport(
    report({
      actions: [
        { ...searchButton, beforeUrl: "https://fixture.example/", afterUrl: "https://fixture.example/" },
        { ...searchButton, beforeUrl: "https://fixture.example/docs", afterUrl: "https://fixture.example/docs" },
      ],
    }),
    false,
  );
  assert.match(text, /What Trace tried \(1\)/);
  assert.match(text, /\? desktop button "Search" \(on 2 pages\)/);
});
