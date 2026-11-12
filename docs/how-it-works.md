# How Trace works

Trace takes one public URL, visits it in a real browser at desktop and mobile sizes, tries a small sample of
what a visitor would do, and writes a short report. It is a bounded review, not a full audit.

## What gets checked

Each check opens separate desktop and mobile browser contexts and looks at:

- **Page health:** page and resource responses, HTTPS, broken images, load-time JavaScript errors, mobile
  overflow, and selected security headers.
- **Accessibility signals:** form labels, image alt text, unnamed controls, document language, controls skipped
  by tab order, and a small sample of text contrast.
- **Search preview:** title, description, viewport, H1, and noindex.
- **Performance:** LCP, layout shift, and long tasks from this one visit. These are not field Core Web Vitals.

The desktop visit watches for one second after load and the mobile reload watches for half a second.

## Visitor paths

`src/journey.ts` reads the page title and first headings and picks a likely visitor path with a few plain rules:

- locations and memberships for gyms
- products for shops
- work and contact for portfolios
- service info for software sites

Anything else falls back to prominent content and nav links. It's a heuristic, so it can guess wrong.

The desktop sample follows up to three same-origin links in total. The first destination can add one follow-up
link, which makes a two-step path. Fragment-only anchors, query links, visited URLs, and anything that looks
state-changing are skipped. Menus and search/filter controls go first; slideshow controls and accessibility
widgets are skipped. On each sampled page Trace tries up to four buttons and two forms. The mobile visit checks
controls on the entry page without following links.

"Passed" means the recorded response or state change happened. It doesn't mean signup, checkout, search
relevance, or login works.

## Forms and searches

Form checks use real Playwright actions:

- `fill`
- `selectOption`
- `setChecked`
- Tab
- click

They test editing and the browser's own required-field validation while every outgoing request is blocked at
both the page and context level. The document is torn down before the block is lifted, so a delayed input
handler can't send the test values. Password, card, file, and one-time-code fields are left alone.

A GET search form can submit the query `trace` to its own origin, but only when the search box is its only
enabled, named control. The navigation guard allows that exact path and query and blocks everything else. A
real HTTP error is reported; changed content is only an observation. Even a GET can have side effects on a badly
built site, so only check sites you're allowed to.

## Findings

Every finding comes from browser or DOM evidence and falls into one of three groups:

- **Observed problems:** HTTP errors on normal loads, broken images, plain HTTP pages or form targets,
  certificate errors, and uncaught JavaScript errors that weren't caused by Trace blocking a request.
- **Review items:** ambiguous failed requests, incomplete loads, access challenges, non-HTML URLs, and
  script errors that Trace's own restrictions might have caused.
- **Recommendations:** missing or obviously broken security headers. A missing header isn't proof of a
  vulnerability, and a present one isn't proof the policy is right.

Some noise rules:

- Cancelled requests are grouped into one note.
- A cancel is dropped if the same URL later loaded fine.
- An HTTP error isn't counted again as a cancellation.
- Prefetch refusals are review items.
- CSP blocks are described as the site's own policy doing its job.
- Proxy failures are blamed on Trace, not the site.

Contrast is only sampled on solid, opaque backgrounds. Clipped, offscreen, and composited text is skipped
instead of assuming white.

## Report layout

`src/report.ts` groups the raw findings into problems, things to review, and optional improvements. Repeated
signals are grouped and distinct resource URLs are counted, not events. A normal sampling cap is kept separate
from a check that was actually interrupted.

`src/terminal-report.ts` prints the short terminal version: the page, what Trace tried (each action with its
viewport and outcome), then the grouped findings. The same button tried on several pages is shown once with a
page count. Colors are only used when the output goes to a terminal, so CI logs stay plain.

## Comparing two versions

`src/compare.ts` powers `webtrace diff`. Both versions are checked one after the other, then:

- actions are matched by viewport, kind, and label (case and spacing ignored)
- a link counts as the same destination if its path matches, since the two versions live on different hosts
- something that passed before and failed now is "stopped working"; a confirmed problem that wasn't there
  before is a "new problem"; only those two fail the run
- actions tried on only one version are counted but never treated as broken, because exploration is sampled
- review items such as one-visit speed measurements are left out, since they vary between runs

## Screenshots

`src/screenshot-evidence.ts` captures failed or unverified actions before the page is restored. It also marks
representative elements for DOM findings with a red outline and a numbered badge. Each report gets:

- at most four action images and six finding images
- JPEG files of 80 KB or less, with one lower-quality retry when a capture is too big
- a 1.5 second capture timeout

Form fields, editable content, and iframes are masked. Images stay in memory; they're only written out as data
URLs inside the file you name with `--json`.

## References

- [MDN HTTP status codes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status)
- [OWASP HTTP headers cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html)
- [MDN Observatory launch post](https://developer.mozilla.org/en-US/blog/mdn-http-observatory-launch/)
- [Playwright actionability](https://playwright.dev/docs/actionability)
