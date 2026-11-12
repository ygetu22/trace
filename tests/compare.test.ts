import assert from "node:assert/strict";
import test from "node:test";
import type { BasicReport } from "../src/basic-check.ts";
import { compareReports } from "../src/compare.ts";

type Action = NonNullable<BasicReport["actions"]>[number];

function report(host: string, overrides: Partial<BasicReport> = {}): BasicReport {
  return {
    id: "fixture",
    requestedUrl: `https://${host}/`,
    finalUrl: `https://${host}/`,
    title: "Fixture",
    status: 200,
    connection: "https",
    capturedAt: "2026-11-11T00:00:00Z",
    durationMs: 1,
    findings: [],
    checked: [],
    incomplete: false,
    limits: [],
    actions: [],
    text: "",
    ...overrides,
  };
}

function link(host: string, label: string, outcome: Action["outcome"], path: string): Action {
  return {
    kind: "navigation",
    viewport: "desktop",
    label,
    beforeUrl: `https://${host}/`,
    afterUrl: `https://${host}${path}`,
    outcome,
    detail: outcome === "failed" ? "The link opened a page that returned HTTP 404." : "Opened.",
    durationMs: 1,
  };
}

function problem(host: string, title: string) {
  return {
    title: "Fixture",
    url: `https://${host}/`,
    response: "HTTP 200",
    summary: "",
    sample: "",
    completion: "",
    sections: [
      {
        kind: "issue" as const,
        title: "Needs attention",
        items: [{ title, detail: `Seen on ${host}/contact.` }],
      },
    ],
  };
}

test("a link that worked before and fails now is reported as stopped working", () => {
  const comparison = compareReports(
    report("live.example", { actions: [link("live.example", "Projects", "passed", "/projects")] }),
    report("preview.example", { actions: [link("preview.example", "Projects", "failed", "/404")] }),
  );
  assert.equal(comparison.broke.length, 1);
  assert.equal(comparison.broke[0]!.after.label, "Projects");
  assert.equal(comparison.unchangedCount, 0);
});

test("the same destination on different hosts counts as unchanged", () => {
  const comparison = compareReports(
    report("live.example", { actions: [link("live.example", "Projects", "passed", "/projects")] }),
    report("preview.example", { actions: [link("preview.example", "projects ", "passed", "/projects")] }),
  );
  assert.equal(comparison.unchangedCount, 1);
  assert.equal(comparison.changed.length, 0);
});

test("a link that now goes somewhere else is changed, not broken", () => {
  const comparison = compareReports(
    report("live.example", { actions: [link("live.example", "Work", "passed", "/projects")] }),
    report("preview.example", { actions: [link("preview.example", "Work", "passed", "/work")] }),
  );
  assert.equal(comparison.changed.length, 1);
  assert.equal(comparison.broke.length, 0);
});

test("actions tried on only one version are not counted as broken", () => {
  const comparison = compareReports(
    report("live.example", { actions: [link("live.example", "Blog", "passed", "/blog")] }),
    report("preview.example", { actions: [link("preview.example", "About", "passed", "/about")] }),
  );
  assert.equal(comparison.broke.length, 0);
  assert.equal(comparison.onlyBefore.length, 1);
  assert.equal(comparison.onlyAfter.length, 1);
});

test("the same problem on both hosts is not new; a different one is", () => {
  const before = report("live.example", { presentation: problem("live.example", "Broken link") });
  const sameProblem = report("preview.example", {
    presentation: problem("preview.example", "Broken link"),
  });
  const otherProblem = report("preview.example", {
    presentation: problem("preview.example", "Missing form label"),
  });

  assert.equal(compareReports(before, sameProblem).newProblems.length, 0);
  const comparison = compareReports(before, otherProblem);
  assert.deepEqual(comparison.newProblems.map((item) => item.title), ["Missing form label"]);
  assert.deepEqual(comparison.fixedProblems.map((item) => item.title), ["Broken link"]);
});
