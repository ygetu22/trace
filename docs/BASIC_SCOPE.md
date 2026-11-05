# October 26 extension: focused visitor paths

Yakob authorized a selected public browsing path, screenshots of failed/unverified actions, and a concise
visual report. This supersedes older no-screenshot/first-page-only presentation limits below. See
[VISITOR_PATHS.md](VISITOR_PATHS.md) for selection, caps, storage, and verification. Sign-in, account creation,
purchases, successful backend submissions, and public deployment remain excluded.

# Local website review: enter a URL, read a focused report

Yakob authorized expanding Trace beyond a first-load check on October 8. This remains a bounded local review, not an exhaustive audit. Do not deploy anything until he explicitly authorizes it.

## Report contract

The local app checks the entered page at desktop and mobile sizes. It inspects actual page/resource responses, HTTPS, visible broken images, load-time JavaScript errors, selected response headers, mobile overflow, form labels, missing image descriptions, unnamed controls, a small sample of text contrast, document language, and controls excluded from normal keyboard tab order. It checks page title/description/viewport/H1/noindex signals and records single-visit LCP/layout-shift/long-task observations. These are scoped signals, not complete accessibility, SEO, performance, or security audits.

The October 9 extension uses separate desktop and mobile browser contexts. On each sampled page, Trace tries up to four eligible buttons and two forms. It follows up to three same-origin desktop links and explores their controls/forms when time remains. Controls with declared expanded/selected state are checked against that state and target visibility. Ordinary buttons with recognizable browsing labels are tried, but content changes alone do not establish a working business feature. Owners can still provide one exact control name and expected new visible text.

Form checks use actual Playwright fill, selectOption, setChecked, Tab, and click actions. They sample editing and browser required-field validation while blocking all outgoing requests at both page and context level. The document is destroyed before releasing that guard so delayed input handlers cannot transmit test values. Deliberately blocked requests are excluded from resource failures; JavaScript errors during the restricted form check are review observations. Password, card, file, and one-time-code fields are excluded. These checks cannot confirm backend acceptance or custom business validation.

A separately identified GET search form may submit `trace` to its same-origin endpoint only when the query is its sole enabled, named control. Other named inputs (including hidden fields and submit buttons), selects, and textareas exclude the form. The navigation guard allows only the expected path and that single sample query. Other methods and out-of-scope navigation are blocked. A real HTTP error becomes a finding; changed content is only an observation, not proof of useful search results. Arbitrary query links remain excluded. A GET can still have side effects on a poorly designed site; only inspect sites the owner is authorized to review.

The action ledger records the label, viewport, page, outcome, duration, and observation. Main text keeps findings and a short coverage summary; clients expose all actions in an expandable section, and the download includes the full recorded action list plus grouped coverage. Verified means the particular recorded assertion passed, not that the complete website feature works. Time and item limits remain explicit; unsupported journeys need an owner-supplied expected result.

- **Observed problems:** actual page/resource HTTP error responses for ordinary loads (excluding explicit speculative-prefetch refusal and Trace-generated errors), visibly broken images, unencrypted HTTP/form targets, certificate rejection, or uncaught JavaScript errors observed without intentionally blocked non-read requests.
- **Review observations:** an unsuccessful request with ambiguous cause, incomplete page load, access challenge, insecure declaration that the browser may upgrade, a non-HTML URL, or JavaScript errors when Trace's restrictions may have influenced the result.
- **Recommendations:** an absent or visibly misconfigured protective response header. Header presence alone does not mean its complete policy is correct, and absence is not proof of exploitability.

Canceled resource requests are grouped into one observation with their URLs. A canceled attempt is omitted when another request for the same URL actually finished with a successful response during the observation window. An HTTP error and its consequent cancellation are not counted twice. Explicit background-prefetch refusals and prefetch-purpose error responses are review observations; ordinary 4xx/5xx resource errors remain observed problems. CSP blocks are described as the browser enforcing the site policy, with impact unverified. Trace-generated proxy connection failures are attributed to Trace rather than the origin. These rules do not suppress non-cancellation connection failures.

Every finding is based on browser or DOM evidence and classified as an issue, review item, or recommendation. A rejected private-resource request is Trace's policy decision, not a confirmed website defect. Contrast is sampled only with a detected solid opaque background. Clipped/offscreen text and complex compositing are skipped; there is no assumed white background. Samples still need visual confirmation. Performance values come from one automated browser visit; they are not field Core Web Vitals. A single page and three sampled links cannot establish whole-site health. Authorization controls, vulnerabilities, full keyboard behavior, screen-reader experience, successful business submissions and complete user journeys remain unverified. No security score or search-ranking promise is inferred.

The result appears as concise text. The text download adds the recorded actions, distinct-resource network observations, and grouped coverage details. Findings are grouped and omit raw stacks and query strings. Reports do not create persistent page-content artifacts on the server.

## Report presentation

Lead with the page title, URL without query data, response, and a one-line summary. Group repeated signals; distinguish confirmed responses from heuristics and recommendations. Do not surface browser cancellations or speculative prefetch refusals. Keep evidence to short locations and actual measurements; omit query strings, raw stacks, and long generic caveats. State the check's key limits once at the end. Keep normal sampling caps distinct from interruptions; do not mark an ordinary cap as a failed check. Group skipped controls by reason and show only a few example names. Count distinct resource URLs, not repeated events, in resource advice.

## Usage contract

Three started investigations per normalized socket IP in a rolling 24 hours. A reservation is written before browser work. A valid started attempt counts even if it fails or is cancelled. Invalid/private URLs and busy/rejected requests do not consume a slot. Repeated URLs still count. Usage is independent of cookies/refreshes and survives a normal server restart. Reservations serialize within the single local process. The user sees the remaining count and earliest next slot time, and a denied request receives HTTP 429.

Ignored `data/usage` stores the private per-install HMAC key and a ledger of hashed identities/timestamps. Raw IPs are not stored. Expired timestamps are pruned during writes, identity count is capped, and malformed state or failed writes deny work. Missing the HMAC key for an existing ledger cannot silently reset identities. Do not delete usage state to run tests; tests use temporary directories.

IP quota is not an absolute anti-abuse guarantee. Shared connections share the allowance and VPNs/IP rotation can change identity. The local server trusts only its socket peer and ignores spoofable forwarding headers. Public deployment needs verified edge identity, durable shared admission across replicas/restarts, and the previously documented isolation/edge protections. None of that is claimed deployed or verified by this local milestone.

For local debugging only, `TRACE_LOCAL_UNLIMITED_UNTIL` or the ignored `data/usage/local-unlimited-until` file may set an ISO timestamp with an explicit timezone. Until that deadline, the loopback checker skips quota reservations and returns `unlimited: true`; after it, the normal persistent quota applies, including after a server restart. The deadline is not used by the gateway or public portfolio API. The portfolio page labels this mode so it cannot be mistaken for the normal allowance.

## Guidance used

The desktop browser observes for one second after load; the mobile reload observes for half a second. The checks use [MDN's HTTP status definitions](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status) and [OWASP's response-header guidance](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html). [MDN's Observatory guidance](https://developer.mozilla.org/en-US/blog/mdn-http-observatory-launch/) also distinguishes measurable header checks from complete website security. The app uses its own observed browser evidence; it does not outsource findings or invent expected feature behavior.


## Unlimited local development

The portfolio's `npm run dev` launcher enables unlimited local checks by default. It passes
`TRACE_LOCAL_UNLIMITED=1` and `NODE_ENV=development` only to the loopback checker. Its usage response has
`unlimited: true`; clients show a development label instead of a remaining allowance. Existing reservations
are kept and are neither consumed nor reset in this mode. Run `TRACE_LOCAL_UNLIMITED=0 npm run dev` to test
the normal quota again. Standalone timed debug overrides remain available separately. This flag is read only
by the local server entry point in development, not by the public gateway or production portfolio API.
