# Trace

Trace opens a website in a real browser, clicks around like a visitor would, and tells you what worked and what didn't. You run it from the terminal as `webtrace`.

I built it because most site checkers only load the homepage and score it. I wanted something that actually tries the menu, follows a few links, types into a form, and tells me when something stops working after I change my site.

```
$ webtrace diff https://playwright.dev https://playwright.dev/python

Comparing
  before  https://playwright.dev/
  after   https://playwright.dev/python/

Changed (3)
  ? desktop link "Testing documentation"
      before: opened /docs/intro
      after:  opened /python/docs/intro
  ...

Same on both: 3 · Tried on only one version: 2

✓ PASSED · nothing stopped working
```

## Setup

You need Node 22 or newer and Google Chrome.

```sh
git clone https://github.com/ygetu22/trace.git
cd trace
npm install
npm run build
npm install -g .
```

That last line adds the `webtrace` command to your terminal. Then:

```sh
export TRACE_BROWSER_CHANNEL=chrome   # use your installed Chrome
webtrace check https://your-site.com
```

No Chrome? Run `npx playwright install chromium` and skip the `export` line.

## Commands

**`webtrace check <url>`** checks one site and prints what Trace tried, any problems, and things worth a look.

**`webtrace diff <before-url> <after-url>`** checks two versions of a site, like your live site and a preview of your next change, and lists:

- **Stopped working:** something that worked before and fails now. This fails the run.
- **New problems:** a confirmed problem that wasn't there before. This also fails the run.
- **Changed:** a link that goes somewhere else now, or a result that needs a look. Doesn't fail.
- **Fixed:** something that was broken before and works now.

Trace picks what to click by itself, so the two runs can try slightly different things. Anything tried on only one version is counted but never treated as broken. Speed numbers change from visit to visit, so they never fail a diff either.

Add `--json trace-results.json` to either command to save the full results.

The command exits with `0` when it passes, `1` when it finds problems, and `2` when it couldn't finish (blocked, timed out, bad URL). That makes it easy to use in a CI step or a script.

## What it checks

- **Page health:** status codes, HTTPS, broken images, JS errors on load, mobile overflow, and some security headers.
- **Accessibility:** missing labels and alt text, unnamed buttons, tab order, and a sample of text contrast.
- **Search preview:** title, description, H1, and noindex.
- **Performance:** LCP, layout shift, and long tasks from one visit. This isn't real-user data.
- **Visitor path:** it guesses what a visitor would want on the site and tries that. On a gym site that's locations, on a shop it's products. On each page it presses up to four buttons, edits up to two forms, and follows up to three links.

It splits findings into real problems, things to review, and recommendations, and it won't call something broken unless it actually saw it break.

## Staying safe on other people's sites

Trace visits sites it doesn't control, so I locked down what it's allowed to do:

- **Forms never submit.** It types into fields and checks the validation, but every outgoing request is blocked while it does. Password, card, and file fields are skipped.
- **Searches are limited.** A search box can only send the word `trace`, and only to its own site.
- **Only reads go out.** POST/PUT requests, WebSockets, downloads, and popups are blocked.
- **No private addresses.** Every request goes through a small proxy (`src/outbound-proxy.ts`) that rejects private, loopback, and cloud metadata addresses. It also pins the IP it checked, so DNS rebinding can't sneak past.
- **Each check is short-lived.** It gets a fresh browser and a 90 second deadline.

Still, only run it on sites you're allowed to test.

## Development

```sh
npm run check   # type check
npm test        # unit + browser tests
TRACE_BROWSER_CHANNEL=chrome TRACE_LIVE_TESTS=1 npm test   # also hits example.com and playwright.dev
```

## Code layout

- `src/cli.ts` is the `webtrace` command, and `src/terminal-report.ts` prints its output.
- `src/compare.ts` compares two runs for `webtrace diff`.
- `src/basic-check.ts` runs a check from start to finish.
- `src/explore.ts` and `src/journey.ts` pick the visitor path and try the buttons and links.
- `src/form-interactions.ts` and `src/search-interactions.ts` handle the form and search tests.
- `src/checks.ts` holds the page health, accessibility, metadata, and performance checks.
- `src/report.ts` groups the findings into problems, things to review, and optional improvements.
- `src/screenshot-evidence.ts` takes the marked-up screenshots.
- `src/network-policy.ts` and `src/outbound-proxy.ts` decide what the browser is allowed to reach.
- `tests/` has the unit and browser tests.

There's more detail in [docs/how-it-works.md](docs/how-it-works.md).
