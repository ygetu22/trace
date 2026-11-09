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

`src/report.ts` builds both the on-screen report and the text download. The report opens with the page title,
the URL without query data, the response, and a one-line summary. Repeated signals are grouped and distinct
resource URLs are counted, not events. Skipped controls are grouped by reason with a few example names. A
normal sampling cap is shown separately from a check that was actually interrupted.

The action ledger records each attempt: label, viewport, page, outcome, duration, and what was seen. The main
report keeps findings and a short coverage summary. The full ledger sits in an expandable section and in the
download.

## Screenshots

`src/screenshot-evidence.ts` captures failed or unverified actions before the page is restored. It also marks
representative elements for DOM findings with a red outline and a numbered badge. Each report gets:

- at most four action images and six finding images
- JPEG files of 80 KB or less, with one lower-quality retry when a capture is too big
- a 1.5 second capture timeout

Missing or oversized images get a short note instead of a placeholder. Form fields, editable content, and
iframes are masked. The page scrolls back and the overlay nodes are removed afterwards.

Images live in memory and come back as JPEG data URLs in the same `no-store` response. Nothing is written to
disk, archived, or given a public URL. Starting a new check or reloading the page clears the report.

## Usage limit

Each IP gets three started checks per rolling 24 hours:

- A slot is reserved before the browser starts, so failed or cancelled checks still count.
- Invalid or private URLs and rejected requests don't use a slot.
- A fourth request gets HTTP 429 with `Retry-After`.

`data/usage` (ignored by git) holds:

- a per-install HMAC key
- hashed identities with timestamps

Raw IPs are never stored. Old timestamps are pruned on write and the number of identities is capped. If the
state is malformed or a write fails, the check is denied rather than allowed. Only the socket peer address is
trusted; forwarding headers are ignored. Reservations are serialized inside one process, so don't run two
servers against the same folder.

An IP limit isn't real bot protection. Shared networks share a quota, and VPNs can change identity. A public
version would need verified identity from a trusted edge and a shared quota store (see
[DEPLOYMENT.md](DEPLOYMENT.md)).

### Local unlimited mode

The portfolio's dev launcher passes `TRACE_LOCAL_UNLIMITED=1` and `NODE_ENV=development` to the local server,
which then skips the quota and returns `unlimited: true`. The UI shows a dev label instead of a count.
`TRACE_LOCAL_UNLIMITED=0 npm run dev` turns the normal limit back on. `TRACE_LOCAL_UNLIMITED_UNTIL` (or
`data/usage/local-unlimited-until`) does the same until an ISO timestamp. None of this is read by the gateway.

## References

- [MDN HTTP status codes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status)
- [OWASP HTTP headers cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html)
- [MDN Observatory launch post](https://developer.mozilla.org/en-US/blog/mdn-http-observatory-launch/)
- [Playwright actionability](https://playwright.dev/docs/actionability)
