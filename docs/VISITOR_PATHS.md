# October 26 evidence extension

Finding cards now link representative sampled elements to red-marked screenshots. Navigation checks usable main
content, location autocomplete is sampled where identifiable, and recovery does not overwrite an uncertain first
click. The current budget is four action images plus six finding images (JPEG <=80 KB each), held in memory only.
This supersedes the earlier four-image-only scope below. See [RESEARCH_AND_EVIDENCE.md](RESEARCH_AND_EVIDENCE.md)
and the latest HANDOFF.md entry for current behavior and verification.

# Visitor paths and screenshot evidence

Trace remains a paste-a-URL check. It chooses a small public browsing sample, shows what each attempt did,
and marks uncertain results as Unverified. Public deployment is still disabled.

## How a path is selected

`src/journey.ts` examines the page title and first headings. Small, explicit rules prioritize locations and
membership for fitness sites, products for shops, work/contact for portfolios, and service information for
software or service pages. Unknown sites fall back to prominent content/navigation links. This is a heuristic,
not an AI planner or a guarantee that Trace understands the business.

The desktop sample follows at most three eligible same-origin links in total. The first selected destination
can contribute one relevant follow-up link, creating a two-step browsing path. Other eligible links fill the
remaining allowance. Fragment-only anchors, queries, excluded actions, and previously visited URLs are skipped.
Menus/search/filter controls receive priority; secondary visual settings, slideshow controls, and accessibility
widgets are skipped in the focused mode. The mobile entry visit checks selected controls without following
another link chain. Both visits retain their existing deadlines.

The report names the inferred path, explains its selection, and lists actual action indices. Passed means the
recorded browsing response/state was observed. It does not establish successful registration, ordering, search
relevance, payment, authentication, or the site's complete service. Existing form/network isolation remains.

## Screenshots

`src/screenshot-evidence.ts` captures failed or unverified actions before a document is restored or destroyed.
There are at most four JPEGs per report, each at most 100 KB, with a 1.5-second capture timeout. Missing or
oversized images get a short explanation. Form fields, editable content, and embedded frames are masked;
identifiable controls are outlined where possible. Screenshots capture public pages in fresh browser contexts.
Masking these elements is not a general guarantee that arbitrary public page text contains no personal data.

Images are held in memory for the run and returned as data URLs, referenced by ID from actions. They are not
written to the server filesystem, archived, indexed, or exposed through an artifact URL. The clients keep only
the current report in memory, clear it on a new run, and lose it on reload/navigation. Users can download each
JPEG. The text download lists evidence IDs but contains no images. A user's downloaded files follow their own
browser/device retention settings. There is no 24-hour server retention or shareable report feature.

The response remains private (`no-store`). The standalone CSP permits data images; the portfolio already permits
them. Both clients accept only bounded JPEG data URLs for evidence. The older public gateway/artifact routes are
not enabled by this work and must be aligned separately before any release.

## Report layout

`src/report.ts` produces a presentation object and matching text findings. The clients render concise sections,
explicit status labels, and action evidence. Accessibility categories are separate cards with practical next
steps. Resource response errors and script errors are review signals, not confirmed visitor-feature failures;
raw grouped observations stay in Check details and the full text download. Duplicate page-response and
navigation findings for the same HTTP failure are presented once. Ordinary sampling caps and omitted browser
observations do not by themselves mean that the visitor sample stopped early.

## Verification

See HANDOFF.md for the latest commands and run evidence. Regression fixtures exercise ordered visitor paths,
a real HTTP failure, blank fragment anchors, global link limits, widget exclusion, field/frame masking, image
caps and cleanup, concise errors, and report classification. UI checks must cover screenshot display/download,
text downloads, both portfolio themes, and small screens. Live websites remain variable, so record actual runs
without claiming their business workflows were fully verified.
