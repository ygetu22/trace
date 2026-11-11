import type { BasicReport } from "./basic-check.ts";
import type { Finding } from "./checks.ts";

interface ReportFindingGroup {
  finding: Finding;
  count: number;
  related: Finding[];
}

// "1 distinct resource" / "3 distinct resources"
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isBackgroundNoise(finding: Finding): boolean {
  if (finding.kind !== "failed-resource") return false;
  return (
    finding.evidence.error === "net::ERR_ABORTED" ||
    Boolean(finding.evidence.speculationRefused) ||
    /\bprefetch\b/i.test(String(finding.evidence.purpose ?? ""))
  );
}

function groupReportFindings(findings: Finding[]): ReportFindingGroup[] {
  const groups = new Map<string, ReportFindingGroup>();
  for (const finding of findings) {
    if (isBackgroundNoise(finding)) continue;
    const classification = finding.classification ?? "review";
    // Interaction and link findings are about one specific control, so two
    // different buttons with the same summary must stay separate in the report.
    const isPerControl =
      finding.kind === "interaction" || finding.kind === "broken-link";
    const controlKey = isPerControl
      ? `${finding.pageUrl}:${finding.evidence.controlLabel}`
      : "";
    const key =
      classification === "recommendation" && finding.kind === "security"
        ? `${classification}:security-headers`
        : `${classification}:${finding.kind}:${finding.summary}:${controlKey}`;
    const group = groups.get(key);
    if (group) {
      group.count++;
      group.related.push(finding);
    } else {
      groups.set(key, { finding, count: 1, related: [finding] });
    }
  }
  return [...groups.values()];
}

function conciseLocation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const pathname =
      url.pathname.length > 70 ? `${url.pathname.slice(0, 67)}…` : url.pathname;
    return `${url.hostname}${pathname === "/" ? "" : pathname}`;
  } catch {
    return undefined;
  }
}

function conciseHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function safePageUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function reportLine(group: ReportFindingGroup): string {
  const { finding, count, related } = group;
  if (
    finding.kind === "security" &&
    (finding.classification ?? "review") === "recommendation"
  ) {
    const list = (items: string[]) =>
      items.length > 1
        ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
        : items[0];
    const headers = (items: Finding[]) => [
      ...new Set(
        items
          .map((item) => String(item.evidence.header ?? "").toUpperCase())
          .filter(Boolean),
      ),
    ];
    const missing = headers(
      related.filter((item) => item.evidence.header && !item.evidence.value),
    );
    const configured = headers(
      related.filter((item) => item.evidence.header && item.evidence.value),
    );
    const framing = related.some(
      (item) => item.evidence.hasFrameAncestors === false,
    );
    const advice = [
      missing.length
        ? `Consider adding ${list(missing)} for additional browser protection.`
        : "",
      configured.length ? `Review the ${list(configured)} configuration.` : "",
      framing
        ? "Set a framing policy if this page should not be embedded elsewhere."
        : "",
    ].filter(Boolean);
    return `• ${advice.join(" ") || "Review the observed response protections."}`;
  }

  const countNote = count > 1 ? ` (${count} related)` : "";
  if (finding.kind === "accessibility") {
    const uniqueItems = (key: string) => [
      ...new Map(
        related
          .flatMap((item) =>
            Array.isArray(item.evidence[key])
              ? (item.evidence[key] as Record<string, unknown>[])
              : [],
          )
          .map((item) => [JSON.stringify(item), item]),
      ).values(),
    ];
    const images = uniqueItems("imagesMissingAlt");
    const controls = uniqueItems("controlsMissingNames");
    const keyboard = uniqueItems("keyboardExcluded");
    const contrast = uniqueItems("lowContrast");
    const languageMissing = related.some(
      (item) => item.evidence.documentLanguageMissing,
    );
    const imageExample = images[0] && conciseLocation(images[0].url);
    const controlExample = controls[0]
      ? `${String(controls[0].tag ?? "control")}${controls[0].id ? `#${String(controls[0].id).slice(0, 40)}` : ""}`
      : "";
    const parts = [
      images.length ? `up to ${images.length} image(s) without alt text` : "",
      controls.length ? `up to ${controls.length} unnamed control(s)` : "",
      languageMissing ? "document language missing" : "",
      keyboard.length
        ? `up to ${keyboard.length} control(s) excluded from normal Tab navigation`
        : "",
      contrast.length
        ? `up to ${contrast.length} possible low-contrast text sample(s)`
        : "",
    ].filter(Boolean);
    const lowestContrast = contrast.sort(
      (left, right) => Number(left.ratio) - Number(right.ratio),
    )[0];
    const contrastExample =
      lowestContrast && Number.isFinite(Number(lowestContrast.ratio))
        ? `“${String(lowestContrast.text ?? "").slice(0, 45)}” ${lowestContrast.ratio}:1`
        : "";
    const examples = [
      imageExample ? `image: ${imageExample}` : "",
      controlExample ? `control: ${controlExample}` : "",
      contrastExample ? `contrast: ${contrastExample}` : "",
    ].filter(Boolean);
    const advice = [
      images.length ? "Add descriptions for meaningful images." : "",
      controls.length ? "Give controls accessible names." : "",
      languageMissing ? "Set the document language." : "",
      keyboard.length ? "Confirm keyboard access." : "",
      contrast.length ? "Check the sampled text contrast visually." : "",
    ].filter(Boolean);
    return `• ${parts.join("; ")}${examples.length ? ` (${examples.join("; ")})` : ""}. ${advice.join(" ")}`;
  }
  if (finding.kind === "search-preview") {
    if (
      related.some(
        (item) =>
          typeof item.evidence.robots === "string" &&
          /\bnoindex\b/i.test(item.evidence.robots),
      )
    )
      return "• Search visibility: page metadata says noindex. Confirm that this is intentional.";
    const items =
      [
        ...new Set(
          related.flatMap((item) =>
            Array.isArray(item.evidence.observations)
              ? (item.evidence.observations as string[])
              : [],
          ),
        ),
      ].join("; ") || "page metadata needs review";
    return `• Search preview: ${items}. Add clear page metadata if search visibility is intended.`;
  }
  if (finding.kind === "form-label") {
    const field = related.flatMap((item) =>
      Array.isArray(item.evidence.fields)
        ? (item.evidence.fields as Record<string, unknown>[])
        : [],
    )[0];
    let selectorNote = "";
    if (field) {
      let fieldName = "";
      if (field.id) fieldName = `#${String(field.id).slice(0, 40)}`;
      else if (field.name) fieldName = `[name=${String(field.name).slice(0, 40)}]`;
      selectorNote = ` (e.g. ${String(field.tag ?? "field")}${fieldName})`;
    }
    return (
      `• ${finding.summary}${selectorNote}${countNote}. ` +
      "Add a visible label or programmatic name; a placeholder alone is not a label."
    );
  }
  if (finding.kind === "performance") {
    const metrics = finding.evidence;
    const parts = [
      typeof metrics.largestContentfulPaintMs === "number"
        ? `largest visible content ${((metrics.largestContentfulPaintMs as number) / 1000).toFixed(1)}s`
        : "",
      typeof metrics.layoutShiftScore === "number"
        ? `layout shift ${metrics.layoutShiftScore}`
        : "",
      typeof metrics.longTasks === "number" && metrics.longTasks
        ? `${metrics.longTasks} long task(s)`
        : "",
    ].filter(Boolean);
    return `• Possible performance concern: ${parts.join(", ")}. One automated visit; confirm with real-user data.`;
  }
  if (finding.kind === "failed-resource" && finding.evidence.error === "csp") {
    const urls = new Set(
      related
        .map((item) => item.evidence.url)
        .filter((url): url is string => typeof url === "string"),
    );
    const resourceCount = urls.size || 1;
    const host = conciseHost(finding.evidence.url);
    const hostNote = host ? ` (${host})` : "";
    return `• Security policy blocked ${plural(resourceCount, "distinct resource")}${hostNote}. Visible impact is unverified.`;
  }
  if (finding.kind === "broken-link") {
    if (finding.evidence.policyBlocked)
      return "• Trace’s network policy or proxy prevented an internal destination from being checked.";
    const location = conciseLocation(
      finding.evidence.finalUrl ?? finding.evidence.href,
    );
    if (finding.evidence.navigationRecovered)
      return "• The destination became usable after one reload; the original click needs review.";
    if (finding.evidence.contentUnverified)
      return `• The destination opened, but usable main content was not confirmed${location ? ` at ${location}` : ""}.`;
    const status =
      typeof finding.evidence.status === "number"
        ? `HTTP ${finding.evidence.status}`
        : finding.evidence.visibleNotFoundMessage
          ? "not-found message shown"
          : "an inconclusive navigation result";
    return `• Internal link ${location ? `to ${location} ` : ""}returned ${status}${countNote}.`;
  }
  if (finding.kind === "interaction") {
    const label =
      typeof finding.evidence.controlLabel === "string"
        ? `“${finding.evidence.controlLabel.slice(0, 80)}”: `
        : "";
    return `• ${label}${finding.summary.replace(/\s+/g, " ").slice(0, 220)} (${conciseLocation(finding.pageUrl)}, ${finding.viewport.width}px)${countNote}`;
  }

  const details: string[] = [];
  const status = finding.evidence.status;
  if (typeof status === "number" && !finding.summary.includes(`HTTP ${status}`))
    details.push(`HTTP ${status}`);
  const locations = [
    ...new Set(
      related
        .map((item) =>
          conciseLocation(item.evidence.url ?? item.evidence.finalUrl),
        )
        .filter((item): item is string => Boolean(item)),
    ),
  ].slice(0, 2);
  if (locations.length) details.push(locations.join(", "));
  if (
    finding.kind === "javascript-error" &&
    typeof finding.evidence.message === "string"
  )
    details.push(
      finding.evidence.message
        .replace(
          /https?:\/\/[^\s"'<>]+/g,
          (url) => conciseLocation(url) ?? "[address]",
        )
        .replace(/\s+/g, " ")
        .slice(0, 140),
    );
  if (
    finding.kind === "security" &&
    typeof finding.evidence.header === "string"
  )
    details.push(finding.evidence.header.toUpperCase());
  return `• ${finding.summary}${countNote}${details.length ? ` — ${details.join(" · ")}` : ""}`;
}

export function summarizeLimits(limits: string[]): string[] {
  const unique = new Set<string>();
  const skipped = new Map<string, Set<string>>();
  for (const value of limits) {
    const match = value.match(
      /^(Desktop|Mobile): Skipped(?: (control|link))? “(.+)”: (.+)$/,
    );
    if (match) {
      const reason = match[4]!.includes("expectation")
        ? "Trace could not reliably verify the intended result"
        : match[4]!.includes("secondary setting")
          ? "secondary settings and widgets"
          : match[4]!.includes("state-changing") ||
              match[4]!.includes("another tab")
            ? "outside the browsing scope"
            : "not reliably identified";
      const key = `${match[2] === "link" ? "link" : "control"}:${reason}`;
      const labels = skipped.get(key) ?? new Set<string>();
      labels.add(match[3]!);
      skipped.set(key, labels);
      continue;
    }
    if (value.startsWith("Desktop and mobile visits")) {
      unique.add(
        "Sample: desktop and mobile; up to four controls and two forms per page, plus three same-site links.",
      );
    } else if (value.startsWith("Only HTTP/HTTPS")) {
      unique.add(
        "Public HTTP/HTTPS only. Form editing blocks outgoing requests; only identifiable GET searches submit a sample query.",
      );
    } else if (
      !value.startsWith("Canceled requests") &&
      !value.startsWith("Page observations are time-limited")
    ) {
      unique.add(
        value.replace(
          /https?:\/\/[^\s]+/g,
          (url) => conciseLocation(url) ?? "[page]",
        ),
      );
    }
  }
  for (const [key, labels] of skipped) {
    const [kind, reason] = key.split(":");
    const examples = [...labels].slice(0, 3).join(", ");
    unique.add(
      `${plural(labels.size, `distinct ${kind}`)} skipped: ${reason} (e.g. ${examples}).`,
    );
  }
  return [...unique];
}

function sampledInteractions(report: Omit<BasicReport, "text">): string {
  const coverage = report.coverage;
  const counted = (
    count: number | undefined,
    singular: string,
    plural = `${singular}s`,
  ) => (count ? `${count} ${count === 1 ? singular : plural}` : "");
  const parts = [
    counted(coverage?.controlsTested, "control"),
    counted(coverage?.formsTested, "form"),
    counted(coverage?.searchesTested, "search", "searches"),
    counted(coverage?.linksTested, "internal link"),
  ].filter(Boolean);
  return parts.length
    ? `Tried: ${parts.join(", ")}.`
    : "No eligible interactions were tested.";
}

export function formatBasicReport(report: Omit<BasicReport, "text">): string {
  const presentation = buildReportPresentation(report);
  const connection =
    report.status === null
      ? "No successful response"
      : `HTTP ${report.status}${report.connection === "https" ? " · HTTPS" : report.connection === "http" ? " · unencrypted HTTP" : ""}`;
  const status =
    report.coverage?.status ??
    (report.incomplete ? "interrupted" : "completed");
  const summary = presentation.summary;
  const completion =
    status === "blocked"
      ? "Access blocked; ordinary page behavior was not checked."
      : status === "interrupted"
        ? "Stopped early; some checks did not finish."
        : status === "restricted"
          ? "Sample completed with request restrictions."
          : "Sample completed.";
  const lines = [
    "TRACE — WEBSITE CHECK",
    "",
    `${report.title || "Untitled page"} · ${connection}`,
    safePageUrl(report.finalUrl),
    "",
    `Summary: ${summary}`,
    sampledInteractions(report),
    `${completion}${report.coverage?.samplingLimited ? " Sampling limits reached." : ""}`,
  ];
  for (const section of presentation.sections) {
    const heading =
      section.kind === "issue"
        ? "NEEDS ATTENTION"
        : section.kind === "review"
          ? "REVIEW"
          : "OPTIONAL IMPROVEMENTS";
    lines.push(
      "",
      heading,
      ...section.items.map(
        (item) =>
          `• ${item.title}${item.detail !== item.title ? ` — ${item.detail}` : ""}${item.nextStep ? ` ${item.nextStep}` : ""}`,
      ),
    );
  }
  if (report.journey) {
    lines.push(
      "",
      `Selected visitor path: ${report.journey.name}.`,
      report.journey.detail,
    );
  }
  if (report.coverage?.featureResult) {
    const feature = report.coverage.featureResult;
    lines.push(
      "",
      `Requested check: ${feature.label} — desktop ${feature.desktopOutcome}${feature.mobileOutcome ? `, mobile ${feature.mobileOutcome}` : ""}.`,
    );
  }
  lines.push(
    "",
    "Scope: sampled public pages. Sign-in, purchases, and successful backend submissions are untested.",
  );
  return lines.join("\n");
}

export function networkObservations(findings: Finding[]): string[] {
  return groupReportFindings(
    findings.filter(
      (finding) =>
        finding.kind === "failed-resource" ||
        finding.kind === "javascript-error",
    ),
  ).map((group) => reportLine(group).replace(/^• /, ""));
}

export function formatReportDownload(
  report: Omit<BasicReport, "text">,
): string {
  const lines = [formatBasicReport(report)];
  if (report.coverage?.featureResult)
    lines.push(
      `Expected after click: “${report.coverage.featureResult.expectedText}”.`,
    );
  if (report.actions?.length) {
    lines.push("", "ACTIONS TRIED");
    for (const action of report.actions) {
      const outcome =
        action.outcome === "passed"
          ? "Passed"
          : action.outcome === "failed"
            ? "Failed"
            : "Unverified";
      const detail = action.detail.replace(
        /https?:\/\/[^\s]+/g,
        (url) => conciseLocation(url) ?? "[page]",
      );
      const label = action.label || "Unnamed action";
      const location = conciseLocation(action.beforeUrl);
      let evidenceNote = "";
      if (action.evidenceId)
        evidenceNote = ` [Screenshot ${action.evidenceId}; save separately.]`;
      else if (action.evidenceNote) evidenceNote = ` [${action.evidenceNote}]`;
      lines.push(
        `• ${outcome} · ${action.viewport} · ${label} (${location}) — ${detail}${evidenceNote}`,
      );
    }
  }
  const findingEvidence = buildReportPresentation(report).sections.flatMap(
    (section) =>
      section.items.flatMap((item) =>
        (item.examples ?? []).map((example) => {
          const evidence = example.evidenceId
            ? `Screenshot ${example.evidenceId} (save separately).`
            : (example.evidenceNote ?? "No screenshot available.");
          return `• ${item.title} — ${example.label}: ${evidence}`;
        }),
      ),
  );
  if (findingEvidence.length)
    lines.push("", "FINDING EVIDENCE", ...findingEvidence);
  const observations = groupReportFindings(
    report.findings.filter(
      (finding) =>
        finding.kind === "failed-resource" ||
        finding.kind === "javascript-error",
    ),
  );
  if (observations.length)
    lines.push(
      "",
      "BROWSER OBSERVATIONS (VISIBLE IMPACT UNVERIFIED)",
      ...observations.map(reportLine),
    );
  if (report.limits.length)
    lines.push(
      "",
      "COVERAGE",
      ...summarizeLimits(report.limits)
        .filter(
          (limit) => !networkObservations(report.findings).includes(limit),
        )
        .map((limit) => `• ${limit}`),
    );
  return lines.join("\n");
}

export interface ReportItem {
  title: string;
  detail: string;
  nextStep?: string;
  location?: string;
  examples?: { label: string; evidenceId?: string; evidenceNote?: string }[];
}

export interface ReportPresentation {
  title: string;
  url: string;
  response: string;
  summary: string;
  sample: string;
  completion: string;
  sections: {
    kind: "issue" | "review" | "recommendation";
    title: string;
    items: ReportItem[];
  }[];
}

export function buildReportPresentation(
  report: Omit<BasicReport, "text">,
): ReportPresentation {
  const sections: ReportPresentation["sections"] = [
    { kind: "issue", title: "Needs attention", items: [] },
    { kind: "review", title: "Needs review", items: [] },
    { kind: "recommendation", title: "Optional improvements", items: [] },
  ];
  const groups = groupReportFindings(report.findings);
  for (const group of groups) {
    const finding = group.finding;
    // Browser/network noise has no demonstrated visitor impact; retain it in Check details.
    if (
      finding.kind === "failed-resource" ||
      finding.kind === "javascript-error"
    )
      continue;
    if (
      finding.kind === "page-response" &&
      report.findings.some(
        (other) =>
          other.kind === "broken-link" &&
          other.evidence.finalUrl === finding.pageUrl &&
          other.evidence.status === finding.evidence.status,
      )
    )
      continue;
    const section = sections.find(
      (item) => item.kind === (finding.classification ?? "review"),
    )!;
    const location = conciseLocation(finding.pageUrl);
    if (finding.kind === "accessibility") {
      const categories = [
        [
          "imagesMissingAlt",
          "Images missing alt attributes",
          "Add descriptions to meaningful images; use empty alt text for decorative ones.",
        ],
        [
          "controlsMissingNames",
          "Controls without accessible names",
          "Give each control a name that explains its action.",
        ],
        [
          "keyboardExcluded",
          "Controls excluded from Tab navigation",
          "Check whether visitors can reach these controls using the keyboard.",
        ],
        [
          "lowContrast",
          "Possible text contrast problems",
          "Check the text against its visible background.",
        ],
      ] as const;
      for (const [key, title, nextStep] of categories) {
        const values = [
          ...new Map(
            group.related
              .flatMap((item) =>
                Array.isArray(item.evidence[key])
                  ? (item.evidence[key] as Record<string, unknown>[])
                  : [],
              )
              .map((value) => [JSON.stringify(value), value]),
          ).values(),
        ];
        if (!values.length) continue;
        const example = values[0]!;
        const exampleNote = example.id
          ? ` Example: ${String(example.tag ?? "element")}#${String(example.id).slice(0, 60)}.`
          : "";
        const detail =
          key === "lowContrast"
            ? `“${String(example.text ?? "").slice(0, 80)}” · ${example.ratio}:1 (sampled).`
            : `${plural(values.length, "distinct sample")} found.${exampleNote}`;
        const examples = group.related.flatMap(
          (item) =>
            item.visualEvidence?.filter(
              (example) => example.category === key,
            ) ?? [],
        );
        section.items.push({
          title,
          detail,
          nextStep,
          location,
          examples: examples.slice(0, 3),
        });
      }
      if (group.related.some((item) => item.evidence.documentLanguageMissing))
        section.items.push({
          title: "Page language is missing",
          detail: "The page has no declared document language.",
          nextStep: "Set the page's language on the HTML element.",
          location,
        });
    } else {
      section.items.push({
        title:
          finding.kind === "interaction"
            ? String(
                finding.evidence.controlLabel || "Interaction needs review",
              )
            : finding.kind === "broken-link"
              ? "Navigation needs attention"
              : finding.kind === "security" &&
                  finding.classification === "recommendation"
                ? "Browser protections worth reviewing"
                : finding.summary,
        detail: reportLine(group).replace(/^• /, ""),
        location,
        examples: (() => {
          const examples = group.related.flatMap(
            (item) => item.visualEvidence ?? [],
          );
          if (
            finding.kind === "interaction" ||
            finding.kind === "broken-link"
          ) {
            const action = report.actions?.find(
              (action) =>
                action.label === finding.evidence.controlLabel &&
                action.beforeUrl === finding.pageUrl &&
                (action.viewport === "mobile") ===
                  finding.viewport.width <= 600 &&
                action.outcome !== "passed",
            );
            if (action)
              examples.push({
                category: "action",
                label: action.label,
                evidenceId: action.evidenceId,
                evidenceNote: action.evidenceNote,
              });
          }
          return examples.slice(0, 3);
        })(),
      });
    }
  }
  const resourceErrors = report.findings.filter(
    (finding) =>
      finding.kind === "failed-resource" &&
      typeof finding.evidence.status === "number" &&
      finding.evidence.status >= 400 &&
      !finding.evidence.policyBlocked &&
      !finding.evidence.proxyError &&
      !finding.evidence.speculationRefused &&
      !/prefetch/i.test(String(finding.evidence.purpose ?? "")),
  );
  const resources = new Set(
    resourceErrors.map((finding) => String(finding.evidence.url ?? "unknown")),
  );
  if (resources.size) {
    const first = resourceErrors[0]!;
    const firstLocation = conciseLocation(first.evidence.url);
    const locationNote = firstLocation ? ` · ${firstLocation}` : "";
    sections[1]!.items.push({
      title: "Resources unavailable during this scan",
      detail: `${plural(resources.size, "distinct resource")} returned an error. Example: HTTP ${first.evidence.status}${locationNote}.`,
      nextStep:
        "Compare in an ordinary browser. An effect on visible features has not been confirmed.",
    });
  }
  const scriptErrors = report.findings.filter(
    (finding) => finding.kind === "javascript-error",
  );
  const distinctMessages = new Set(
    scriptErrors.map((finding) => String(finding.evidence.message)),
  );
  if (scriptErrors.length)
    sections[1]!.items.push({
      title: "Script errors observed",
      detail: `${distinctMessages.size} distinct error message(s). Request restrictions may have contributed; details are below.`,
      nextStep:
        "Check whether a visitor-facing feature is affected before treating these as defects.",
    });
  const issues = sections[0]!.items.length;
  const reviews = sections[1]!.items.length;
  const status =
    report.coverage?.status ??
    (report.incomplete ? "interrupted" : "completed");
  return {
    title: report.title || "Untitled page",
    url: safePageUrl(report.finalUrl),
    response:
      report.status === null
        ? "No page response"
        : `HTTP ${report.status}${report.connection === "https" ? " · HTTPS" : ""}`,
    summary: issues
      ? `${issues} item${issues === 1 ? " needs" : "s need"} attention.`
      : reviews
        ? `No confirmed problems. ${reviews} item${reviews === 1 ? " needs" : "s need"} review.`
        : report.incomplete
          ? "No confirmed problems in the completed portion."
          : "No confirmed problems in the sampled checks.",
    sample: sampledInteractions(report),
    completion:
      status === "blocked"
        ? "Access blocked. The ordinary site could not be checked."
        : status === "interrupted"
          ? "Stopped early. See Check details for the reason."
          : status === "restricted"
            ? "Sample finished with request restrictions."
            : "Sample finished.",
    sections: sections.filter((section) => section.items.length),
  };
}
