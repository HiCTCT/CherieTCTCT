# Browser-first Phase 0 — local measurement

Phase 0 is **hand-run, dry-run-only instrumentation**. Its only job is to measure
whether the current browser discovery + capture workflow is reliable *before* we
build any Phase 1 automation. Phase 0 writes **no database rows**: no Prisma, no
SQLite, no ingestion, no scheduler, no migrations. It never bypasses, solves,
rotates proxies for, or otherwise evades a Meta challenge or block — it only
detects and records one.

Everything below is run by hand, one competitor at a time, and produces **local
files only** (all git-ignored). Nothing here is committed.

---

## 1. Run one discovery (with logging)

This is the existing discovery script, now instrumented. It opens one
competitor's Meta Ad Library page, discovers active ad (Library) IDs, writes the
browser-collected CSV, and additionally writes a structured discovery-run log.

```
set COMPETITOR_NAME=Castlery
set META_PAGE_ID=123456789012345          # or META_AD_LIBRARY_URL=...
set OUTPUT_FILE=data/imports/castlery-browser-collected-ads.csv
set MAX_ADS=10                            # explicit cap — discovery is deliberately limited
set HEADLESS=false                        # headful so you can watch it
npm run phase0:discover                   # alias of browser:create-csv
```

Run **one competitor per command**. `MAX_ADS` is a hard cap; reaching it is a
deliberate stop, not a sign that the advertiser has exactly that many ads.

### Where the logs go

Next to the output CSV (`OUTPUT_FILE` with the `.csv` removed):

| File | Contents |
| --- | --- |
| `<output>.csv` | the browser-collected CSV (unchanged schema) |
| `<output>.extraction-log.txt` | the existing human-readable run log |
| `<output>.discovery-run-log.json` | **new** structured Phase 0 discovery log |

The JSON log records: competitor, Meta Page ID, country, input URL, output CSV
path, algorithm version, started/completed time, total duration, navigation
duration, time-to-first-ID, configured `MAX_ADS`, scroll cycles attempted,
no-growth cycles reached, IDs per scroll cycle, the stop condition and whether it
was reached, discovered Library-ID count, output row count, READY vs
NEEDS_REVIEW counts, source CSV byte size, the discovery status, any
challenge/throttle/interstitial signal, and an error summary.

### Discovery statuses (what they mean)

Exactly five statuses. A status describes **how the run went**, never how many
ads a competitor has. A non-successful status is **never** read as "zero ads" and
is **never** used to mark previously-seen ads inactive.

Classification follows a strict **priority order — a blocker always wins over a
generic failure**: (1) `BLOCKED_DISCOVERY`, (2) `FAILED_DISCOVERY`,
(3) `PARTIAL_DISCOVERY`, (4) `SUCCESSFUL_DISCOVERY`, (5) `INCOMPLETE_DISCOVERY`.

| Status | Meaning |
| --- | --- |
| `BLOCKED_DISCOVERY` | A challenge / login wall / CAPTCHA / rate-limit / security-check / unexpected interstitial was detected (the matched signal is recorded). Found IDs are preserved; the run is not treated as complete. **Always wins over failure.** |
| `FAILED_DISCOVERY` | The listing never loaded or an unexpected error threw, **and** zero IDs were discovered. |
| `PARTIAL_DISCOVERY` | Reaching the **`MAX_ADS` cap is ALWAYS partial** (a deliberate cap is never a complete count; `capped=true`, stop condition `max_ads_cap`), **or** some IDs found but the run did not finish cleanly (error after IDs, or the `MAX_SCROLLS` budget ran out while still growing). Never an official complete browser count. |
| `SUCCESSFUL_DISCOVERY` | Either **(a) non-empty**: **observed final-URL canonical scope confirmed** (resolved URL whose path is **exactly** `/ads/library` (or `/ads/library/`) with each of `view_all_page_id`, `country`, `active_status=active`, `ad_type=all` present **exactly once**, optional Meta UI-default params allowed **only at their exact approved values**, and **no narrowing/unknown/duplicate params**), no blocker, no error, **not capped**, stable no-growth completion via stop condition `no_growth_limit`; or **(b) confirmed no-active-ads**: a **visible, explicit Meta page/advertiser "is not running ads" statement** detected (`no_active_ads_proven`, recorded with the matched approved phrase + element tag/box only), zero IDs, canonical scope confirmed, no blocker, no error, ended via stop condition `confirmed_no_active_ads`; or **(c) canonical empty active-scope**: under confirmed canonical scope, zero IDs, no blocker/error, **not capped**, a **single shared visible empty-results container** proves `No ads match your search criteria` + `Remove or adjust any filters you've applied to get different results.` + a visible `Clear Filters` control (`canonical_empty_active_scope_proven`; `no_active_ads_proven` stays **false**), ended via stop condition `confirmed_canonical_empty_active_scope` — meaning zero ads **within that exact scope only**, never an inventory verdict. |
| `INCOMPLETE_DISCOVERY` | Zero IDs **without** the explicit no-active-ads evidence above — ambiguous (no clear ad-card or no-results signal). |

**Scope confirmation means the observed final browser scope, not configured inputs.**
The final resolved Ad Library URL (after navigation and any retry/reload) must still have a
path of **exactly** `/ads/library` (or `/ads/library/`) — nested or extended paths that merely
contain that text are rejected — and prove the **canonical Phase 0 scope**: exact `view_all_page_id` +
`country`, `active_status=active`, `ad_type=all`, and **no narrowing or unknown query
parameters** (`q`, `search_terms`, `start_date`, `end_date`, `publisher_platforms`, or
anything that changes the ad set). **Each required canonical parameter (`view_all_page_id`,
`country`, `active_status`, `ad_type`) must appear EXACTLY ONCE** — a missing or duplicated
required parameter fails scope proof (recorded as `missing_*` / `duplicate_scope_params`,
names only). Unknown / scope-changing parameters also fail closed; only their **names** are
recorded, never their values.

A small set of optional **Meta Ad Library UI-default parameters** is tolerated, but **only by
exact value** — an explicit allowlist, never by name alone. Each may be absent; when present it
must appear **exactly once** and equal its one approved value:

| Parameter | Approved value |
| --- | --- |
| `media_type` | `all` |
| `search_type` | `page` |
| `is_targeted_country` | `false` |
| `sort_data[mode]` | `total_impressions` |
| `sort_data[direction]` | `desc` |

A duplicate, a differing value, or a malformed value of any of these **fails** scope
confirmation; no other value of these names is permitted, and no parameter is whitelisted by
name alone. The run log records names/status only via `allowed_meta_ui_defaults_present`,
`noncanonical_meta_ui_params`, and `duplicate_meta_ui_params` — never the values. If any
requirement is unmet, `scope_confirmed=false` and the run cannot be `SUCCESSFUL_DISCOVERY`.

#### One-time scope-parameter diagnostic (opt-in)

Set `PHASE0_SCOPE_PROBE=true` to additionally record, in the discovery run log, the **values**
of five specific Meta-UI query parameters that appeared in controlled runs — `media_type`,
`search_type`, `is_targeted_country`, `sort_data[mode]`, `sort_data[direction]`. This is a
**one-time Phase 0 measurement aid** to help decide, later, whether any of these can be added
to a future **explicit allowlist by parameter name AND exact value**. It does **not** change
the scope classifier: `scope_confirmed`, `unexpected_scope_params`, and the discovery statuses
are unchanged, these parameters still fail the strict scope proof today, and **no parameter is
whitelisted by name alone**.

When the flag is set, the run log gains `observed_meta_ui_param_values`, an array with one
entry per **present** probed parameter:

```json
"observed_meta_ui_param_values": [
  { "name": "media_type", "count": 1, "values": ["all"] },
  { "name": "sort_data[mode]", "count": 1, "values": ["relevancy_monthly_grouped"] }
]
```

Only these five names are inspected. A value is recorded only when it matches
`^[A-Za-z0-9_-]{1,80}$`; otherwise it is stored as `"[redacted]"`. The full final URL,
arbitrary unknown parameters, tokens, redirects, and free-text URLs are **never** logged.
When `PHASE0_SCOPE_PROBE` is not `true`, the field is omitted entirely and no values are read.

A zero-ID run is recorded as `SUCCESSFUL_DISCOVERY` **only** with confirmed
no-active-ads evidence: canonical scope proof first, zero IDs, no blocker/error, and a
**visible element that specifically states this Page/advertiser is not running ads**
(e.g. "this page isn't running ads", "this advertiser is not running ads"). The matched
element and every ancestor to the document root must be visible (no `display:none`,
`visibility:hidden`/`collapse`, `opacity:0`, `aria-hidden="true"`) and the element must have
a non-zero box. Generic messages — `no ads found`, `no ads to show`,
`no results found for this search`, bare `0 results` / `no results` — are **not** accepted as
advertiser-no-ads proof. Only the matched approved phrase, tag, and box are logged.

A **separate, scope-limited** success exists for Meta's *empty-results* state — stop condition
`confirmed_canonical_empty_active_scope`, flag `canonical_empty_active_scope_proven`. It means
**"Meta showed zero ads within this exact canonical active/all/country scope"** and is **never** a
claim that the advertiser has no ads at all (other countries, inactive history, or any other
scope). It requires, under already-confirmed canonical scope and zero IDs with no blocker/error
and **not capped**, a **single shared visible empty-results container** that proves all three:
the exact direct text `No ads match your search criteria`, the exact direct text `Remove or
adjust any filters you've applied to get different results.`, and a visible control with direct
text `Clear Filters`. The three must share a **real lowest common visible ancestor** (never
`body`/`html`) with a non-zero box; that container, every matched element, and every ancestor to
the document root must pass the visibility rules; and the `Clear Filters` control must be inside
that same container. Generic page-wide text containing `No ads match your search criteria` is
**insufficient** unless the complete shared container is proven. `no_active_ads_proven` stays
`false` on this path, and only labels (`no_ads_match`, `remove_or_adjust_filters`,
`clear_filters_control`, `shared_empty_results_container`), element tags, and bounding boxes are
logged — never raw phrases, page text, URLs, or filter values.

Absent **either** the advertiser-no-ads proof **or** the canonical empty-results proof, zero IDs
stay `zero_cards` / `INCOMPLETE_DISCOVERY`.

The challenge/block detector is conservative and text-signal only. When it fires,
the run is **always** classified `BLOCKED_DISCOVERY` — **even where Library IDs were
already collected**. The found IDs are preserved and the matched signal is recorded,
but the run is **never** considered complete. It does **not** attempt to bypass or
solve anything.

---

## 2. Measure capture output

Read-only report over capture output **already on disk**. No browser, no
Vision/API spend, no DB writes.

```
npm run phase0:measure-captures
# optional filters:
set COMPETITOR=castlery
set ASSETS_DIR=data/creative-assets
set IMPORTS_DIR=data/imports
```

It reports, per competitor and overall:

- creative asset counts by type — `IMAGE` (`image-*.png`), `CAROUSEL_CARD`
  (`card-*.png`), `VIDEO_FRAME` (`frame-*.png`), plus video source files;
- asset bytes by type (a rough storage/cost proxy);
- verified-meta sidecar quality — ACCEPT / REVIEW / REJECT counts for
  `headline_status`, `description_status`, and `verification_status`, plus the
  tallied REVIEW / REJECT reasons and capture-strategy counts;
- `collection_status` (READY vs NEEDS_REVIEW) from any `*.with-assets.csv`.

The report is written to `data/imports/phase0-reports/phase0-capture-measurement.<timestamp>.json`
(git-ignored). These counts describe captured assets and sidecar rows only —
never a competitor's true ad inventory.

---

## 3. Browser-vs-API count comparison

Read-only diagnostic that compares the count the **browser** observed against the
count the **Meta Ad Library API** returns for the same page ID. It makes only
read-only Graph API GET calls; it does **not** write to Prisma/SQLite, does **not**
run ingestion, and is **not** `meta:batch:scheduled`.

```
set META_ADLIB_TOKEN=...                          # required for a real API count
set COMPETITORS=castlery=123456,boconcept=789     # fixed name=metaPageId list (Phase 0 hard max: 5)
set META_COUNTRY=SG
set API_ACTIVE_STATUS=ACTIVE                       # match the browser's active-only view
npm run phase0:browser-vs-api
```

Without `META_ADLIB_TOKEN` the Meta client runs in simulation mode; the script
detects this and marks every row `SIMULATION_NO_TOKEN` (an ineligible, non-verdict
state) instead of treating mock data as real.

**Identity is the exact Meta Page ID, never the competitor name or filename.** A
browser observation is matched to a competitor only when its own `meta_page_id`
(the discovery-run-log field, or the `meta_page_id` column of a browser CSV) equals
the competitor's page ID. The newest matching discovery-run log wins (by
`completed_at`, falling back to file mtime). Competitor names are used purely as
human-readable report labels.

A comparison is **eligible** (`comparison_status = COMPARED`) **only** when the
matched browser observation is a clean `SUCCESSFUL_DISCOVERY`, **not capped**, has
recorded `scope_confirmed = true` (never inferred from the status alone), an exact
page-ID match, a **non-empty observed final-URL country that exactly equals** the requested
`META_COUNTRY` (case-insensitively; the configured `meta_country` is only an audit label),
the browser log's observed scope is canonical (`observed_active_status=active`,
`observed_ad_type=all`), the **API query scope is also canonical** (`API_ACTIVE_STATUS=ACTIVE`,
`api_ad_type=ALL`), and a stop condition of `no_growth_limit` or `confirmed_no_active_ads`.
Otherwise the result is **ineligible**
with a specific status — one of `INELIGIBLE_NO_BROWSER_OBSERVATION`,
`INELIGIBLE_BROWSER_PARTIAL`, `INELIGIBLE_BROWSER_BLOCKED`,
`INELIGIBLE_BROWSER_INCOMPLETE`, `INELIGIBLE_BROWSER_FAILED`,
`INELIGIBLE_BROWSER_CAPPED`, or `INELIGIBLE_SCOPE_MISMATCH` (plus API-side
`SIMULATION_NO_TOKEN`, `API_ERROR`, `API_CAPPED_LOWER_BOUND`).

For every ineligible result the raw browser and API counts are retained for
reference only, `count_difference` is left **null**, and the row is clearly **not**
an official completeness comparison. The report is written to
`data/imports/phase0-reports/phase0-browser-vs-api.<timestamp>.json` (git-ignored).

**Neither count is ever a complete inventory and this report is never an official
completeness verdict.** Both the browser view and the API view are filtered, capped,
and time-sensitive.

---

## What Phase 0 does NOT do

- No database writes of any kind (no Prisma, no SQLite, no ingestion, no
  migrations, no scheduler/queue/worker).
- No Vision/Anthropic spend beyond what the existing manual capture commands
  already do.
- No bypassing, solving, dismissing-by-force, proxy-rotating, or evading of any
  Meta challenge or block.
- No change to the existing verified-meta safety rules, carousel agreement,
  no-clobber merge, raw-listing-headline exclusion, or output CSV schema.
- No more than five competitors per browser-vs-API run — a deliberate Phase 0 cohort
  guard, rejected before any API call, not a production-scale workflow.
- No raw URLs in the logs: `input_url` is stored as a sanitised canonical URL (origin +
  `/ads/library` + only `active_status`, `ad_type`, `country`, `view_all_page_id`), and
  challenge signals, error summaries, and scope diagnostics carry no raw or redirect URLs.

All Phase 0 output files (`*.discovery-run-log.json`, the
`data/imports/phase0-reports/` folder) are git-ignored and must not be committed.
