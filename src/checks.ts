import type { Page, Request } from "playwright";

export interface Finding {
  kind:
    | "failed-resource"
    | "javascript-error"
    | "mobile-overflow"
    | "security"
    | "page-response"
    | "broken-image"
    | "form-label"
    | "accessibility"
    | "search-preview"
    | "performance"
    | "interaction"
    | "broken-link"
    | "access-challenge";
  classification?: "issue" | "review" | "recommendation";
  explanation?: string;
  screenshotUrl?: string;
  visualEvidence?: {
    category: string;
    label: string;
    evidenceId?: string;
    evidenceNote?: string;
  }[];
  pageUrl: string;
  viewport: { width: number; height: number };
  summary: string;
  evidence: Record<string, unknown>;
  reproduce: string[];
}

// Shared with interaction checks so intentional blocks cannot become site failures.
const restrictedInteractionPages = new WeakSet<Page>();
export function setInteractionRestricted(page: Page, restricted: boolean) {
  if (restricted) restrictedInteractionPages.add(page);
  else restrictedInteractionPages.delete(page);
}

const intentionallyBlockedRequests = new WeakSet<Request>();
export function markRequestBlocked(request: Request) {
  intentionallyBlockedRequests.add(request);
}

// Bound page-controlled output so a noisy page cannot grow a report indefinitely.
export function observePage(
  page: Page,
  viewport: { width: number; height: number },
) {
  const findings: Finding[] = [];
  let omittedFindings = 0;
  let observing = true;
  const responses = new WeakMap<Request, number>();
  const completedUrls = new Set<string>();
  function add(
    kind: Finding["kind"],
    summary: string,
    evidence: Finding["evidence"],
  ) {
    if (!observing) return;
    if (findings.length >= 100) {
      omittedFindings++;
      return;
    }
    const observedViewport = page.viewportSize() ?? viewport;
    findings.push({
      kind,
      pageUrl: page.url(),
      viewport: observedViewport,
      summary,
      evidence,
      classification:
        kind === "javascript-error" && !restrictedInteractionPages.has(page)
          ? "issue"
          : "review",
      ...(restrictedInteractionPages.has(page)
        ? {
            explanation:
              "Observed while Trace intentionally blocked form requests; compare in an ordinary browser.",
          }
        : {}),
      reproduce: [
        `Open this page in a fresh browser at ${observedViewport.width} × ${observedViewport.height}.`,
        "Reload and wait for the load event. Inspect the browser Console and Network panels.",
      ],
    });
  }
  page.on("pageerror", (error) =>
    add("javascript-error", "Uncaught JavaScript error", {
      message: error.message.slice(0, 2000),
      stack: error.stack?.slice(0, 4000),
    }),
  );
  page.on("response", (response) => {
    const request = response.request();
    responses.set(request, response.status());
    if (response.status() >= 400 && !request.isNavigationRequest()) {
      const headers = response.headers();
      const purpose =
        request.headers()["sec-purpose"] ?? request.headers().purpose;
      add("failed-resource", `Resource returned HTTP ${response.status()}`, {
        url: response.url().slice(0, 2048),
        status: response.status(),
        resourceType: request.resourceType(),
        ...(headers["x-trace-policy-blocked"] === "1"
          ? { policyBlocked: true }
          : {}),
        ...(headers["x-trace-proxy-error"] === "1" ? { proxyError: true } : {}),
        ...(headers["cf-speculation-refused"]
          ? {
              speculationRefused: headers["cf-speculation-refused"].slice(
                0,
                300,
              ),
            }
          : {}),
        ...(purpose ? { purpose: purpose.slice(0, 300) } : {}),
      });
    }
  });
  page.on("requestfinished", (request) => {
    const status = responses.get(request);
    if (
      observing &&
      status !== undefined &&
      status < 400 &&
      completedUrls.size < 1000
    )
      completedUrls.add(request.url().slice(0, 2048));
  });
  page.on("requestfailed", (request) => {
    // Non-read requests are deliberately blocked by Trace, not website failures.
    if (
      !intentionallyBlockedRequests.has(request) &&
      !request.isNavigationRequest() &&
      ["GET", "HEAD"].includes(request.method()) &&
      (responses.get(request) ?? 0) < 400
    ) {
      add("failed-resource", "Resource request did not complete", {
        url: request.url().slice(0, 2048),
        resourceType: request.resourceType(),
        error: request.failure()?.errorText.slice(0, 2000),
      });
    }
  });
  return {
    findings,
    completedUrls,
    stop: () => {
      observing = false;
    },
    get omittedFindings() {
      return omittedFindings;
    },
  };
}

export async function inspectPage(
  page: Page,
  status: number | undefined,
  headers: Record<string, string> | undefined,
): Promise<Finding[]> {
  const viewport = page.viewportSize()!;
  const pageUrl = page.url();
  const findings: Finding[] = [];
  function add(
    kind: Finding["kind"],
    classification: NonNullable<Finding["classification"]>,
    summary: string,
    evidence: Finding["evidence"],
    explanation: string,
  ) {
    findings.push({
      kind,
      classification,
      summary,
      pageUrl,
      viewport,
      evidence,
      explanation,
      reproduce: [
        `Open ${pageUrl} at ${viewport.width} × ${viewport.height}.`,
        "Inspect the element or response shown in the evidence after the page loads.",
      ],
    });
  }
  if (status !== undefined && status >= 400) {
    add(
      "page-response",
      "issue",
      `Page returned HTTP ${status}`,
      { status },
      "The browser received an error response. An access challenge can also produce this result.",
    );
  }
  const secure = new URL(pageUrl).protocol === "https:";
  if (!secure) {
    add(
      "security",
      "issue",
      "Page uses an unencrypted HTTP connection",
      { finalUrl: pageUrl, protocol: "http:" },
      "Serve this page over HTTPS and redirect HTTP traffic. Information sent over this connection is not protected by TLS.",
    );
  }
  const dom = await page.evaluate(() => {
    const targetOf = (element: Element) => {
      const parts: string[] = [];
      for (
        let current: Element | null = element;
        current && parts.length < 8;
        current = current.parentElement
      ) {
        const tag = current.tagName.toLowerCase();
        if (
          current.id &&
          document.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1
        ) {
          parts.unshift(`#${CSS.escape(current.id)}`);
          break;
        }
        const siblings = current.parentElement
          ? [...current.parentElement.children].filter(
              (sibling) => sibling.tagName === current!.tagName,
            )
          : [current];
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
      }
      const label =
        element.getAttribute("aria-label") ||
        element.getAttribute("alt") ||
        element.textContent?.trim() ||
        element.getAttribute("title") ||
        element.tagName.toLowerCase();
      return {
        selector: parts.join(" > "),
        elementLabel: label.replace(/\s+/g, " ").slice(0, 100),
      };
    };
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    return {
      title: document.title.slice(0, 300),
      challenge:
        /just a moment|attention required|verify (?:you are|you're) human|security verification/i.test(
          document.title,
        ) ||
        !!document.querySelector(
          "#challenge-running, #challenge-stage, form#challenge-form",
        ),
      cspMeta: Array.from(
        document.querySelectorAll(
          'meta[http-equiv="Content-Security-Policy" i][content]',
        ),
      ).some((element) => element.getAttribute("content")?.trim()),
      images: Array.from(document.images)
        .filter(
          (image) =>
            visible(image) &&
            image.complete &&
            image.naturalWidth === 0 &&
            !!image.currentSrc,
        )
        .slice(0, 10)
        .map((image) => ({
          ...targetOf(image),
          url: image.currentSrc.slice(0, 2048),
          alt: image.alt.slice(0, 200),
        })),
      missingAlt: Array.from(document.images)
        .filter((image) => visible(image) && !image.hasAttribute("alt"))
        .slice(0, 12)
        .map((image) => ({
          ...targetOf(image),
          url: image.currentSrc.slice(0, 2048),
        })),
      unlabeled: Array.from(
        document.querySelectorAll<
          HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
        >("input, select, textarea"),
      )
        .filter((input) => {
          if (
            !visible(input) ||
            input.matches(
              'input[type="hidden"], input[type="submit"], input[type="button"], input[type="reset"]',
            )
          )
            return false;
          const referenced = (input.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .some((id) => document.getElementById(id)?.textContent?.trim());
          return (
            !input.labels?.length &&
            !input.getAttribute("aria-label")?.trim() &&
            !referenced &&
            !input.title.trim()
          );
        })
        .slice(0, 10)
        .map((input) => ({
          ...targetOf(input),
          tag: input.tagName.toLowerCase(),
          type: input.getAttribute("type"),
          name: input.name.slice(0, 200),
          id: input.id.slice(0, 200),
          placeholder: input.getAttribute("placeholder")?.slice(0, 200),
        })),
      unnamedControls: Array.from(
        document.querySelectorAll<HTMLElement>(
          "a[href], button, [role=button], [role=link], input[type=button], input[type=submit]",
        ),
      )
        .filter(
          (element) =>
            visible(element) &&
            !element.matches(":disabled, [aria-disabled=true]"),
        )
        .filter((element) => {
          const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .filter(Boolean);
          const referencedText = labelledBy
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
            .join(" ");
          const imageText = Array.from(
            element.querySelectorAll("img[alt]"),
            (image) => (image as HTMLImageElement).alt,
          ).join(" ");
          return !(
            element.getAttribute("aria-label")?.trim() ||
            referencedText ||
            element.getAttribute("title")?.trim() ||
            element.textContent?.trim() ||
            imageText ||
            (element instanceof HTMLInputElement && element.value.trim())
          );
        })
        .slice(0, 12)
        .map((element) => ({
          ...targetOf(element),
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          id: element.id.slice(0, 160),
          href:
            element instanceof HTMLAnchorElement
              ? element.href.slice(0, 2048)
              : undefined,
        })),
      missingLanguage: !document.documentElement.getAttribute("lang")?.trim(),
      keyboardExcluded: Array.from(
        document.querySelectorAll<HTMLElement>(
          "a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link]",
        ),
      )
        .filter(
          (element) =>
            visible(element) &&
            element.matches(":disabled, [aria-disabled=true]") === false &&
            element.tabIndex < 0,
        )
        .slice(0, 10)
        .map((element) => ({
          ...targetOf(element),
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          id: element.id.slice(0, 160),
          label: (
            element.textContent ||
            element.getAttribute("aria-label") ||
            ""
          )
            .trim()
            .slice(0, 120),
        })),
      lowContrast: (() => {
        type Color = { r: number; g: number; b: number; a: number };
        const parse = (value: string): Color | undefined => {
          const match = value.match(
            /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i,
          );
          return match
            ? {
                r: Number(match[1]),
                g: Number(match[2]),
                b: Number(match[3]),
                a: match[4] === undefined ? 1 : Number(match[4]),
              }
            : undefined;
        };
        const luminance = (color: Color) =>
          [color.r, color.g, color.b]
            .map((part) => {
              const channel = part / 255;
              return channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4;
            })
            .reduce(
              (sum, channel, index) =>
                sum + channel * [0.2126, 0.7152, 0.0722][index]!,
              0,
            );
        const samples = new Map<
          string,
          {
            text: string;
            ratio: number;
            color: string;
            background: string;
            tag: string;
            id: string;
            selector: string;
            elementLabel: string;
          }
        >();
        const mediaLayers = [
          ...document.querySelectorAll("canvas, video, iframe, img"),
        ]
          .slice(0, 100)
          .map((element) => element.getBoundingClientRect())
          .filter((rect) => rect.width > 1 && rect.height > 1);
        for (const element of [
          ...document.querySelectorAll<HTMLElement>(
            "p, li, a, button, label, h1, h2, h3, h4",
          ),
        ].slice(0, 300)) {
          const text = element.innerText.trim().replace(/\s+/g, " ");
          if (!text || !visible(element) || text.length < 3) continue;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          if (
            rect.width <= 1 ||
            rect.height <= 1 ||
            rect.right <= 0 ||
            rect.bottom <= 0 ||
            rect.left >= innerWidth ||
            rect.top >= innerHeight
          )
            continue;
          if (
            mediaLayers.some(
              (layer) =>
                layer.left < rect.right &&
                layer.right > rect.left &&
                layer.top < rect.bottom &&
                layer.bottom > rect.top,
            )
          )
            continue;
          const foreground = parse(style.color);
          if (
            !foreground ||
            foreground.a < 1 ||
            style.backgroundImage !== "none"
          )
            continue;
          let ancestor: HTMLElement | null = element;
          let background: Color | undefined;
          let backgroundText = "";
          let unsupported = false;
          while (ancestor) {
            const ancestorStyle = getComputedStyle(ancestor);
            if (
              ancestorStyle.backgroundImage !== "none" ||
              Number(ancestorStyle.opacity) < 1 ||
              ancestorStyle.clipPath !== "none" ||
              ancestorStyle.clip !== "auto" ||
              ancestorStyle.filter !== "none" ||
              ancestorStyle.backdropFilter !== "none" ||
              ancestorStyle.mixBlendMode !== "normal"
            ) {
              unsupported = true;
              break;
            }
            for (const pseudo of ["::before", "::after"]) {
              const layer = getComputedStyle(ancestor, pseudo);
              if (
                !["none", "normal", ""].includes(layer.content) &&
                (layer.backgroundImage !== "none" ||
                  (parse(layer.backgroundColor)?.a ?? 0) > 0)
              )
                unsupported = true;
            }
            if (unsupported) break;
            const candidate = parse(ancestorStyle.backgroundColor);
            if (!background && candidate && candidate.a > 0) {
              if (candidate.a < 1) {
                unsupported = true;
                break;
              }
              background = candidate;
              backgroundText = ancestorStyle.backgroundColor;
            }
            ancestor = ancestor.parentElement;
          }
          if (unsupported || !background) continue;
          const first = luminance(foreground),
            second = luminance(background);
          const ratio =
            (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
          const largeText =
            parseFloat(style.fontSize) >= 24 ||
            (parseFloat(style.fontSize) >= 18.66 &&
              Number(style.fontWeight) >= 700);
          if (ratio >= (largeText ? 3 : 4.5)) continue;
          const key = `${style.color}:${backgroundText}:${Math.round(ratio * 10)}`;
          if (!samples.has(key))
            samples.set(key, {
              ...targetOf(element),
              text: text.slice(0, 120),
              ratio: Number(ratio.toFixed(2)),
              color: style.color,
              background: backgroundText,
              tag: element.tagName.toLowerCase(),
              id: element.id.slice(0, 120),
            });
          if (samples.size >= 12) break;
        }
        return [...samples.values()];
      })(),
      seo: {
        title: document.title.trim().slice(0, 300),
        description:
          document
            .querySelector<HTMLMetaElement>('meta[name="description" i]')
            ?.content.trim()
            .slice(0, 300) ?? "",
        robots:
          document
            .querySelector<HTMLMetaElement>('meta[name="robots" i]')
            ?.content.trim()
            .slice(0, 300) ?? "",
        canonical:
          document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
            ?.href ?? "",
        viewport:
          document.querySelector<HTMLMetaElement>('meta[name="viewport" i]')
            ?.content ?? "",
        headings: Array.from(
          document.querySelectorAll("h1"),
          (heading) => heading.textContent?.trim().slice(0, 160) ?? "",
        ).slice(0, 6),
      },
      insecureForms: Array.from(document.forms)
        .filter(
          (form) => new URL(form.action, location.href).protocol === "http:",
        )
        .slice(0, 10)
        .map((form) => ({
          action: form.action.slice(0, 2048),
          method: form.method,
        })),
      insecureResources: Array.from(
        document.querySelectorAll(
          "script[src], link[rel=stylesheet][href], img[src], iframe[src], video[src], audio[src]",
        ),
      )
        .flatMap((element) => {
          try {
            const url = new URL(
              element.getAttribute("src") ?? element.getAttribute("href")!,
              document.baseURI,
            );
            return url.protocol === "http:"
              ? [
                  {
                    tag: element.tagName.toLowerCase(),
                    url: url.href.slice(0, 2048),
                  },
                ]
              : [];
          } catch {
            return [];
          }
        })
        .slice(0, 10),
    };
  });
  if (dom.challenge) {
    add(
      "access-challenge",
      "review",
      "Page appears to be an access or bot challenge",
      { title: dom.title, status },
      "Trace received a challenge instead of the ordinary page. Feature testing is skipped; this run cannot establish whether the site's features work.",
    );
  }
  if (secure && dom.insecureResources.length) {
    add(
      "security",
      "review",
      "HTTPS page declares insecure resource URLs",
      { resources: dom.insecureResources },
      "These declarations may be upgraded or blocked by the browser. Use HTTPS resource URLs and inspect network evidence; this does not prove insecure content was delivered.",
    );
  }
  if (dom.insecureForms.length) {
    add(
      "security",
      "issue",
      "Form targets use HTTP",
      { forms: dom.insecureForms },
      "Use HTTPS form actions to protect data in transit. Trace did not submit these forms.",
    );
  }
  if (headers) {
    for (const [header, description] of [
      [
        "strict-transport-security",
        "HSTS tells browsers to keep future connections on HTTPS.",
      ],
      [
        "content-security-policy",
        "A Content Security Policy can restrict script and resource execution.",
      ],
      [
        "x-content-type-options",
        "The nosniff directive limits MIME type guessing.",
      ],
      [
        "referrer-policy",
        "An explicit referrer policy controls how much address information is shared.",
      ],
    ] as const) {
      if (
        (header === "strict-transport-security" && !secure) ||
        (header === "content-security-policy" && dom.cspMeta)
      )
        continue;
      if (!headers[header]) {
        add(
          "security",
          "recommendation",
          `Response has no ${header} header`,
          { header, value: null },
          `${description} Missing this header is a hardening opportunity, not proof of an exploitable vulnerability.`,
        );
      }
    }
    if (
      secure &&
      headers["strict-transport-security"] &&
      !/\bmax-age\s*=\s*[1-9]\d*\b/i.test(headers["strict-transport-security"])
    ) {
      add(
        "security",
        "recommendation",
        "HSTS header has no detected positive max-age",
        {
          header: "strict-transport-security",
          value: headers["strict-transport-security"].slice(0, 1000),
        },
        "A zero max-age disables HSTS. Review the header syntax and choose a deployment-appropriate positive lifetime.",
      );
    }
    if (
      headers["x-content-type-options"] &&
      headers["x-content-type-options"].trim().toLowerCase() !== "nosniff"
    ) {
      add(
        "security",
        "recommendation",
        "Content type protection is not set to nosniff",
        {
          header: "x-content-type-options",
          value: headers["x-content-type-options"].slice(0, 1000),
        },
        "Use X-Content-Type-Options: nosniff with correct response content types.",
      );
    }
    if (
      !/^(DENY|SAMEORIGIN)$/i.test(headers["x-frame-options"]?.trim() ?? "") &&
      !/(?:^|;)\s*frame-ancestors\s+/i.test(
        headers["content-security-policy"] ?? "",
      )
    ) {
      add(
        "security",
        "recommendation",
        "No detected response policy restricting framing",
        {
          "x-frame-options": headers["x-frame-options"]?.slice(0, 1000) ?? null,
          hasFrameAncestors: false,
        },
        "If this page should not be embedded by other sites, configure CSP frame-ancestors or X-Frame-Options. Some pages intentionally support embedding; this is not a confirmed vulnerability.",
      );
    }
  }
  if (dom.images.length)
    add(
      "broken-image",
      "issue",
      "Visible images failed to decode",
      { images: dom.images },
      "These displayed image elements finished loading without a usable image. Check their source URLs and file formats.",
    );
  if (dom.unlabeled.length)
    add(
      "form-label",
      "review",
      "Form fields have no detected accessible label",
      { fields: dom.unlabeled },
      "Add associated labels or accessible names. Placeholders alone do not label fields. This is a focused DOM check, not a full accessibility audit.",
    );
  if (
    dom.missingAlt.length ||
    dom.unnamedControls.length ||
    dom.missingLanguage ||
    dom.keyboardExcluded.length ||
    dom.lowContrast.length
  ) {
    add(
      "accessibility",
      "review",
      "Some visible content or controls may be difficult to use with assistive technology or a keyboard",
      {
        imagesMissingAlt: dom.missingAlt,
        controlsMissingNames: dom.unnamedControls,
        documentLanguageMissing: dom.missingLanguage,
        keyboardExcluded: dom.keyboardExcluded,
        lowContrast: dom.lowContrast,
      },
      "These are specific automated accessibility signals, not a complete WCAG audit. Contrast is sampled only where Trace can identify solid foreground/background colors; verify visually and with keyboard or assistive technology.",
    );
  }
  const searchNotes: string[] = [];
  if (!dom.seo.title) searchNotes.push("page title is missing");
  if (!dom.seo.description) searchNotes.push("meta description is missing");
  if (!dom.seo.viewport)
    searchNotes.push("mobile viewport metadata is missing");
  if (!dom.seo.headings.length) searchNotes.push("no H1 heading was found");
  if (searchNotes.length)
    add(
      "search-preview",
      "recommendation",
      "Page metadata may limit how this page appears in search",
      {
        observations: searchNotes,
        title: dom.seo.title,
        robots: dom.seo.robots,
        h1Count: dom.seo.headings.length,
      },
      "Review these page-level signals if this page is intended to appear in search. Trace cannot determine the owner's indexing intent or guarantee rankings.",
    );
  if (/\bnoindex\b/i.test(dom.seo.robots))
    add(
      "search-preview",
      "review",
      "Page metadata asks search engines not to index this page",
      { robots: dom.seo.robots },
      "This may be intentional for a private or temporary page. Confirm the setting matches the owner's search visibility goal.",
    );
  return findings;
}

export async function inspectPerformance(
  page: Page,
): Promise<Finding | undefined> {
  const viewport = page.viewportSize()!;
  const metrics = await page.evaluate(async () => {
    const values: { lcp?: number; cls: number; longTasks: number } = {
      cls: 0,
      longTasks: 0,
    };
    try {
      const lcp = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries.at(-1);
        if (last) values.lcp = Math.round(last.startTime);
      });
      lcp.observe({ type: "largest-contentful-paint", buffered: true });
      const shifts = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        })[])
          if (!entry.hadRecentInput) values.cls += entry.value;
      });
      shifts.observe({ type: "layout-shift", buffered: true });
      const tasks = new PerformanceObserver((list) => {
        values.longTasks += list.getEntries().length;
      });
      tasks.observe({ type: "longtask", buffered: true });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      lcp.disconnect();
      shifts.disconnect();
      tasks.disconnect();
    } catch {
      /* Unsupported performance entry types are simply omitted. */
    }
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return {
      ...values,
      domContentLoaded: navigation
        ? Math.round(navigation.domContentLoadedEventEnd)
        : null,
      load: navigation ? Math.round(navigation.loadEventEnd) : null,
    };
  });
  const hasUsefulMetric =
    metrics.lcp !== undefined ||
    metrics.domContentLoaded !== null ||
    metrics.load !== null;
  if (!hasUsefulMetric) return undefined;
  const slowLcp = metrics.lcp !== undefined && metrics.lcp > 2500;
  const highShift = metrics.cls > 0.1;
  const longTasks = metrics.longTasks >= 3;
  if (!slowLcp && !highShift && !longTasks) return undefined;
  return {
    kind: "performance",
    classification: "review",
    summary: "Possibly slow page load or layout shift",
    pageUrl: page.url(),
    viewport,
    evidence: {
      largestContentfulPaintMs: metrics.lcp ?? null,
      layoutShiftScore: Number(metrics.cls.toFixed(3)),
      longTasks: metrics.longTasks,
      domContentLoadedMs: metrics.domContentLoaded,
      loadEventMs: metrics.load,
    },
    explanation:
      "These are measurements from one automated visit, not real-user Core Web Vitals. Repeat with field data before prioritizing a performance change.",
    reproduce: [
      "Open the page on a typical device and network.",
      "Compare repeated visits with real-user performance data.",
    ],
  };
}

export async function checkMobileOverflow(
  page: Page,
  viewport: { width: number; height: number },
): Promise<Finding | undefined> {
  const evidence = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const documentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
    );
    const elements: { tag: string; id: string; left: number; right: number }[] =
      [];
    if (documentWidth > viewportWidth + 1) {
      for (const element of document.querySelectorAll("body *")) {
        const rect = element.getBoundingClientRect();
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > viewportWidth + 1
        ) {
          elements.push({
            tag: element.tagName.toLowerCase(),
            id: element.id.slice(0, 200),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
          });
          if (elements.length === 10) break;
        }
      }
    }
    return { viewportWidth, documentWidth, elements };
  });
  if (evidence.documentWidth <= evidence.viewportWidth + 1) return undefined;
  return {
    kind: "mobile-overflow",
    pageUrl: page.url(),
    viewport,
    summary: `Page extends ${evidence.documentWidth - evidence.viewportWidth}px beyond the mobile viewport`,
    evidence,
    reproduce: [
      `Open this page at ${viewport.width} × ${viewport.height} in a fresh browser.`,
      "Reload, wait for the load event, and inspect horizontal scrolling and elements outside the viewport.",
    ],
  };
}
