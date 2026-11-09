# Trace

Enter a public website URL and get a concise report based on a bounded browser review. Trace stays local; nothing is deployed.

## What this version checks

1. **Page health:** HTTP/HTTPS, certificate acceptance, resource and image errors, load-time JavaScript errors, mobile overflow, and selected security headers.
2. **Accessibility signals:** missing form labels/image alt text/control names, missing document language, controls skipped by keyboard tab order, and contrast samples where colors are solid enough to estimate.
3. **Search preview:** page title, description, viewport, H1, and noindex directives.
4. **Performance:** single-visit LCP, layout shift, and long-task observations; these are not real-user Core Web Vitals.
5. **Browser interactions:** up to four buttons and two forms per sampled page, an identifiable GET search, and three same-origin desktop links within the time budget. Linked pages also receive interaction checks when time remains. Form checks fill a sample field, change a dropdown, toggle a checkbox, and attempt required-field rejection while blocking network requests. Owners can provide one control and the text expected after clicking. Reports include an expandable action ledger.

The report separates observed problems, observations to review, and recommendations. Missing headers do not establish exploitable vulnerabilities. Automated accessibility signals, single-visit performance, and metadata are limited indicators, not complete audits. Trace cannot infer intended business behavior or establish that a website is fully secure. An optional feature check lets an owner name one control and expected visible text; Trace tries that exact check on desktop and mobile.

Trace starts separate desktop and mobile browser sessions. Identifiable same-origin GET searches may submit the synthetic query `trace`; all other form checks block outgoing requests. Successful business submissions, sign-in, purchases, and application access controls remain unverified. It blocks non-read requests, WebSockets, popups, downloads, cross-origin exploration navigation, arbitrary query-string links, and candidates that look state-changing. Even GET requests can have side effects on some sites; run checks only on sites you are authorized to inspect.

## Run locally

Requires Node.js 22+ and Playwright Chromium or installed Chrome.

```sh
npm install
npx playwright install chromium
npm run dev
```

Open http://127.0.0.1:3120. With installed Chrome, use `TRACE_BROWSER_CHANNEL=chrome npm run dev`. Run commands from this directory. The server stays bound to loopback; do not expose it publicly.

```sh
npm run check
npm test
TRACE_BROWSER_CHANNEL=chrome TRACE_LIVE_TESTS=1 npm test
npm run build
npm start
```

Tests use temporary quota data, not the user's live allowance. Live tests additionally visit example.com and playwright.dev.

## Three checks per IP in 24 hours

Each started check uses one of three slots in a rolling 24-hour window, even if the website cannot be reached. Invalid/private URLs and requests rejected before admission do not use a slot. Refreshing, clearing cookies, and restarting the server do not reset usage. The UI shows remaining checks and the next available time; the API rejects a fourth check with HTTP 429 and Retry-After.

The single local server stores a salted HMAC of the socket IP and timestamps under ignored `data/usage`, using private file permissions and atomic replacement. Raw IPs are not stored. IPv4-mapped addresses normalize to the same identity. Client-provided forwarding headers are ignored. Missing/corrupt quota data or storage failures do not silently grant checks. Preserve the quota directory across server restarts. Do not run multiple server processes against it: this implementation serializes reservations within one process, not across replicas.

Every browser on this computer shares its loopback IP allowance. On a public site, a trusted edge must supply the verified client identity to a persistent, shared quota service; do not simply trust X-Forwarded-For or CF-Connecting-IP from arbitrary requests. Shared networks share an IP quota; VPNs and rotating IPs can change identity. IP limits are not complete bot protection.

## API and safety boundaries

`POST /api/captures` accepts `{ "url": "https://example.com", "featureCheck": { "label": "Show hours", "expectedText": "Open until 5 PM" } }`; the optional `featureCheck` must include both strings. The response includes the text report and usage. `GET /api/usage` returns remaining allowance without consuming it. Reports are downloadable as `.txt` and are not stored in a public run archive. The basic server does not serve old screenshots or trace artifacts.

A fresh browser visits the page through the validating outbound proxy. Private/loopback/metadata destinations and nonstandard ports are rejected; vetted public addresses are pinned for connections. Service workers, non-read requests, WebSockets, downloads, and popups are blocked. One check runs at a time with a 90-second deadline and cleanup. Browser restrictions can affect rendering, and GETs cannot guarantee a website has no side effects.

## Ownership and paused work

- `src/basic-check.ts`: bounded site review orchestration and plain-text report.
- `src/local-server.ts` and `src/server.ts`: local API, validation, admission, deadlines, and startup.
- `src/daily-quota.ts`: persistent three-check limit.
- `src/form-interactions.ts` and `src/search-interactions.ts`: bounded real browser form editing/validation and GET search actions.
- `src/checks.ts`: browser observations, page/header, accessibility, metadata, and performance checks.
- `src/network-policy.ts` and `src/outbound-proxy.ts`: public destination validation and pinned network access.
- `web`: the single-input, text-report client; `tests`: meaningful regressions.

`explore.ts` provides bounded same-site link and button, search, and form sampling without saving screenshots in the current report. Hosting and the old artifact gateway remain inactive. The portfolio uses this checker through its local-only integration. More detail is in [how it works](docs/how-it-works.md).
