const form = document.querySelector("#capture-form");
const input = document.querySelector("#website-url");
const button = document.querySelector("#capture-button");
const progress = document.querySelector("#progress");
const error = document.querySelector("#error");
const result = document.querySelector("#result");
const usageText = document.querySelector("#usage");
const quotaStamp = document.querySelector(".stamp");
function conciseLocation(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return "Page";
  }
}

let reportUrl;
let busy = false;

function showUsage(value) {
  if (!value) return;
  if (value.unlimited) {
    usageText.textContent = "Unlimited checks in development.";
    quotaStamp.textContent = "Local debug mode";
  } else {
    usageText.textContent = `${value.remaining} of 3 checks remaining for this IP in the last 24 hours.${value.retryAt ? ` Next check available ${new Date(value.retryAt).toLocaleString()}.` : ""} Refreshing does not reset this limit. Started checks count even if a website cannot be reached.`;
    quotaStamp.textContent = "3 checks / 24 hours";
  }
  button.disabled = busy || (!value.unlimited && value.remaining === 0);
}

async function refreshUsage() {
  try {
    const response = await fetch("/api/usage", { cache: "no-store" });
    if (!response.ok) throw new Error("Usage tracking is unavailable.");
    showUsage(await response.json());
  } catch {
    button.disabled = true;
    usageText.textContent =
      "Usage tracking is unavailable. Reload to try again.";
  }
}

button.disabled = true;
void refreshUsage();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  button.disabled = true;
  input.readOnly = true;
  result.hidden = true;
  error.hidden = true;
  progress.textContent =
    "Opening pages, trying buttons and form fields, and recording what happens. This can take up to 90 seconds…";
  progress.hidden = false;
  form.setAttribute("aria-busy", "true");
  try {
    const featureLabel = form.elements.namedItem("featureLabel").value.trim();
    const expectedText = form.elements.namedItem("expectedText").value.trim();
    if (Boolean(featureLabel) !== Boolean(expectedText))
      throw new Error(
        "For a feature check, enter both the control name and the expected text.",
      );
    const payload = { url: input.value.trim() };
    if (featureLabel)
      payload.featureCheck = { label: featureLabel, expectedText };
    const response = await fetch("/api/captures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(100_000),
    });
    const report = await response.json();
    showUsage(report.usage);
    if (!response.ok)
      throw new Error(report.error || "The check could not complete.");
    document.querySelector("#report-text").textContent = report.presentation
      ? ""
      : report.text;
    const screenshots = Array.isArray(report.screenshots)
      ? report.screenshots
      : [];
    const overview = document.querySelector("#report-overview");
    overview.replaceChildren();
    const findings = document.querySelector("#report-findings");
    findings.replaceChildren();
    if (report.presentation) {
      const value = report.presentation;
      overview.append(
        node("p", value.response, "hint"),
        node("h3", value.summary),
        node("p", value.title),
        node("p", value.url, "hint"),
        node("p", `${value.sample} ${value.completion}`, "hint"),
      );
      for (const section of value.sections) {
        const group = node(
          section.kind === "recommendation" ? "details" : "section",
          "",
          `finding-section ${section.kind}`,
        );
        group.append(
          node(
            section.kind === "recommendation" ? "summary" : "h3",
            `${section.title} (${section.items.length})`,
          ),
        );
        for (const item of section.items) {
          const card = node("article", "", "finding");
          card.append(
            node("h4", item.title),
            node("p", item.location || "", "hint"),
            node("p", item.detail),
          );
          if (item.nextStep) card.append(node("p", item.nextStep));
          for (const example of item.examples ?? []) {
            const reference = node("div", "", "finding-evidence");
            reference.append(node("p", `Example: ${example.label}`));
            const image = evidenceView(example, screenshots);
            if (image) reference.append(image);
            card.append(reference);
          }
          group.append(card);
        }
        findings.append(group);
      }
    }
    const actions = Array.isArray(report.actions) ? report.actions : [];
    const list = document.querySelector("#action-list");
    list.replaceChildren();
    for (const action of actions) {
      const item = node("li");
      item.append(actionResult(action, screenshots));
      list.append(item);
    }
    const journey = document.querySelector("#journey");
    journey.hidden = !report.journey;
    journey.replaceChildren();
    if (report.journey) {
      journey.append(
        node("p", "Selected visitor path", "eyebrow"),
        node("h3", report.journey.name),
        node("p", report.journey.reason, "hint"),
      );
      const steps = node("ol");
      for (const index of report.journey.steps) {
        if (!actions[index]) continue;
        const step = node("li");
        step.append(actionResult(actions[index], screenshots));
        steps.append(step);
      }
      journey.append(steps, node("p", report.journey.detail, "hint"));
    }
    document.querySelector("#screenshot-note").hidden =
      screenshots.length === 0;
    document.querySelector("#action-details").hidden = actions.length === 0;
    const limits = Array.isArray(report.limits) ? report.limits : [];
    const coverage = document.querySelector("#coverage-list");
    coverage.replaceChildren();
    for (const limit of limits) {
      const item = document.createElement("li");
      item.textContent = limit.replace(/https?:\/\/[^\s]+/g, conciseLocation);
      coverage.append(item);
    }
    document.querySelector("#coverage-details").hidden = limits.length === 0;
    if (reportUrl) URL.revokeObjectURL(reportUrl);
    reportUrl = URL.createObjectURL(
      new Blob([report.downloadText ?? report.text], {
        type: "text/plain;charset=utf-8",
      }),
    );
    document.querySelector("#report-link").href = reportUrl;
    result.hidden = false;
    document.querySelector("#report-title").focus();
  } catch (cause) {
    error.textContent =
      cause instanceof Error ? cause.message : "The check could not complete.";
    error.hidden = false;
  } finally {
    busy = false;
    input.readOnly = false;
    progress.hidden = true;
    form.removeAttribute("aria-busy");
    await refreshUsage();
  }
});

window.addEventListener("pagehide", () => {
  if (reportUrl) URL.revokeObjectURL(reportUrl);
});

function node(tag, text = "", className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}

function actionResult(action, screenshots) {
  const result = node("div", "", "action-result");
  const outcome =
    action.outcome === "passed"
      ? "Passed"
      : action.outcome === "failed"
        ? "Failed"
        : "Unverified";
  const heading = node("div", "", "action-heading");
  heading.append(
    node("strong", action.label || "Unnamed action"),
    node("span", outcome, `outcome ${action.outcome}`),
  );
  result.append(
    heading,
    node(
      "p",
      `${action.viewport} · ${conciseLocation(action.beforeUrl)}`,
      "hint",
    ),
    node("p", action.detail.replace(/https?:\/\/[^\s]+/g, conciseLocation)),
  );
  if (action.expected) {
    const details = node("details", "", "step-details");
    details.append(
      node("summary", "Step details"),
      node("p", `Expected: ${action.expected}`),
      node("p", `Observed: ${action.observed || action.detail}`),
    );
    result.append(details);
  }
  const image = evidenceView(action, screenshots);
  if (image) result.append(image);
  return result;
}

function evidenceView(reference, screenshots) {
  const evidence = screenshots.find(
    (item) =>
      item.id === reference.evidenceId &&
      /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(item.dataUrl) &&
      item.dataUrl.length < 140000,
  );
  if (evidence) {
    const details = node("details", "", "screenshot");
    const img = node("img");
    img.src = evidence.dataUrl;
    img.alt = evidence.caption;
    img.loading = "lazy";
    const save = node("a", "Save screenshot ↓");
    save.href = evidence.dataUrl;
    save.download = `trace-${evidence.id}.jpg`;
    details.append(
      node("summary", "View screenshot"),
      img,
      node("p", evidence.caption, "hint"),
      save,
    );
    return details;
  }
  return reference.evidenceNote
    ? node("p", reference.evidenceNote, "hint")
    : null;
}
