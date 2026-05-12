# Phase 7 — Meta Ad Library API: Diagnostic Findings

**Date:** 2026-05-12
**Status:** Ingestion paused pending resolution
**Branch:** main

---

## Summary

During Phase 7, live Meta Ad Library ingestion was attempted for real competitors
after the client import pipeline was completed. A series of diagnostic tests
confirmed that the Meta Ad Library API token and connection are functional, but
competitor-specific ad retrieval is not returning results as expected.

Live ingestion remains paused. No competitor data has been written to the database
via the API. No schema, scoring, or ingestion logic has been changed as a result
of these findings.

---

## What Was Tested

### Phase 1 — Parameter combination testing (8 tests)

Script: `scripts/diagnose-meta-fetch.ts`

Tested all meaningful combinations of `search_terms`, `search_page_ids`,
`media_type`, and `ad_active_status` for Castlery (page ID `374586035998186`).

**Result:** All 8 tests returned `data: []`.

### Phase 2 — Parameter format testing (14 tests)

Script: `scripts/diagnose-meta-params.ts`

Tested variations in how parameter values are formatted:

- `ad_reached_countries`: `['SG']` vs `["SG"]` vs `SG` (bare) vs omitted
- `ad_type`: `ALL` vs `all` vs omitted
- `ad_active_status`: `ALL` vs `ACTIVE` vs `active` vs `all`
- `search_terms`: keyword present vs empty string vs omitted

**Result:** All 14 tests returned `data: []`.

### Phase 3 — Manual API validation outside the repo

Tested directly against the API using the same token:

| Query | Result |
|-------|--------|
| `search_terms=Singapore` | Real ads returned — token confirmed working |
| `search_page_ids=374586035998186` (Castlery) | `data: []` |
| `search_page_ids=1143803892307840` (Wellaholic) | `data: []` |
| `search_terms=Castlery` | `data: []` |
| `search_terms=Wellaholic` | `data: []` |

---

## Key Finding

The Meta Ad Library API token is valid and API connectivity is confirmed.
Broad geographic/generic queries (`search_terms=Singapore`) return real ad records.

However, competitor-specific queries — whether via `search_page_ids` or brand-name
`search_terms` — return empty results for both Castlery and Wellaholic, despite
both advertisers having confirmed active ads visible in the Meta Ad Library browser
interface (Castlery: approximately 230 active ads in Singapore).

This appears to be a Meta API behaviour or access limitation based on our tests,
but the exact cause is not yet confirmed.

Possible explanations include (but are not limited to):

- The token's associated Meta app may require additional approval for commercial
  advertiser ad queries beyond basic `ads_read` permission
- The Meta Ad Library API may have different access tiers for political vs
  commercial ad data that are not clearly documented
- Specific advertiser page IDs may not be queryable via the API under the current
  token's access scope
- There may be a country-window, archiving, or visibility constraint affecting
  how these specific advertisers' ads are returned

None of these causes is confirmed. Further investigation is required before
drawing a definitive conclusion.

---

## Why Live Ingestion Is Paused

Running live ingestion in the current state would cause the following problems:

1. **Corrupted scan history.** Each ingestion attempt creates a `ScanRun` record
   and updates `competitor.lastScannedAt`. If the API returns 0 ads, these records
   would mark competitors as "scanned today" when no data was actually retrieved.
   This is operationally misleading and difficult to clean up at scale.

2. **No reliable fallback path yet.** Category keyword fetching (see options below)
   would surface ads from many advertisers — not just the target competitor.
   Without a validated post-filtering strategy, ingesting on broad keywords risks
   misattributing ads to the wrong competitor in the database.

3. **Downstream data quality.** Scoring, qualification thresholds, and client
   reporting depend on ads being correctly attributed to the right competitor.
   Structurally dirty data at ingestion time compounds through every downstream
   process.

The blocker is unresolved Meta API behaviour around competitor-specific commercial
ad retrieval. It cannot be resolved by changing query parameters alone.

---

## Revised Fetch Strategy Options

### Option 1 — Page ID first, fallback to category keywords

Keep `search_page_ids` as the primary mechanism. If a page ID returns 0 results,
fall back to a category keyword scoped to the competitor's industry (e.g.
`furniture`, `skincare`, `gym`). Post-filter results by matching `page_id` against
the stored `metaPageId`.

**Trade-off:** Category keywords return a broad set of advertisers. Post-filtering
by `page_id` is reliable if the competitor's ads appear at all — but if they do
not appear in keyword results either, this does not solve the core problem.
Only viable once the underlying access issue is understood.

### Option 2 — Category keyword fetch, post-filter by page_id

Fetch all ads for a broad category keyword in SG. Inspect the returned records
for the target competitor's `page_id`. If found, retain only those records for
ingestion.

**Trade-off:** Relies on the competitor's ads appearing in category keyword results.
Does not require `search_page_ids` to work. Volume of irrelevant records per
fetch is high. Match reliability depends on `page_id` being present and correct
in returned records.

**This is the next diagnostic to run** — see the controlled test plan below.

### Option 3 — Manual advertiser verification workflow

Before any automated ingestion, manually verify that each competitor's page ID
is confirmed accessible via the API. Flag competitors where the API returns 0
as "API not accessible — pending investigation" and exclude them from automated
scan runs until resolved.

**Trade-off:** Time-intensive at scale, but produces no dirty data. Honest and
auditable. Appropriate for high-value competitors while the API issue is being
investigated.

### Option 4 — Browser-assisted collection path

Collect ad data directly from the Meta Ad Library browser interface, which
confirmed access to Castlery's active ads. Parse ad creative, metadata, and
page IDs. Feed into the existing normalisation and analysis pipeline.

**Trade-off:** Browser automation against a third-party UI can be fragile across
UI updates. Not a scalable long-term production approach without significant
engineering. The existing `MetaAdRecord` type and ingestion pipeline would accept
this data without schema changes, making it a viable bridge for high-priority
competitors while the API issue is resolved.

---

## Next Diagnostic: Category Keyword Fetch

Before any code or ingestion changes, run a controlled category keyword test to
determine whether the target competitors' ads appear in broad keyword results.
This is a read-only API call — no DB writes, no ingestion.

**Test 1 — Castlery**

```
search_terms=furniture
ad_reached_countries=SG
ad_active_status=ACTIVE
ad_type=ALL
(no search_page_ids)
limit=25
```

Inspect the returned `page_id` and `page_name` values.
Check whether Castlery page ID `374586035998186` appears in any record.

**Test 2 — Wellaholic**

```
search_terms=slimming
ad_reached_countries=SG
ad_active_status=ACTIVE
ad_type=ALL
(no search_page_ids)
limit=25
```

Inspect the returned `page_id` and `page_name` values.
Check whether Wellaholic page ID `1143803892307840` appears in any record.

**What each result tells us:**

| Outcome | Interpretation |
|---------|---------------|
| Competitor page ID appears in category results | Category keyword fetch with post-filter is a viable ingestion path. Proceed to Option 2 engineering. |
| Category results return ads but competitor page ID absent | Competitor's ads do not surface under this keyword. Try alternative keywords. If all keywords fail, escalate to Meta developer support. |
| Category results also return `data: []` | API access for commercial SG ads may be the broader issue. Investigate token app approval status before any other fetch strategy. |

This diagnostic can be run manually against the API (no script changes required)
or via a lightweight extension to `scripts/diagnose-meta-fetch.ts` if a script
is preferred.

---

## Risks of Live-Ingesting Before This Is Resolved

| Risk | Consequence |
|------|-------------|
| `ScanRun` records created with `newAdsFound=0` | `lastScannedAt` timestamps updated on competitors that returned no data |
| Category keyword fetch without validated post-filter | Ads from unrelated advertisers ingested under wrong competitor |
| `page_name` string matching used as identity proxy | Non-deterministic attribution — silently wrong when names differ slightly |
| Scoring runs on misattributed ads | 7.0 qualification threshold loses meaning |
| Re-ingestion of correct ads blocked | `metaAdId` deduplication will skip correct records already stored under wrong competitor |

---

## Recommended Next Steps

1. **Run the category keyword diagnostic** (read-only, manual or scripted) to
   determine whether Castlery and Wellaholic ads appear in broad keyword results.

2. **Check Meta app approval status** at `developers.facebook.com` for the app
   associated with the current token. Confirm whether the app has been approved
   for Ad Library API access for commercial (non-political) ad queries.

3. **Hold all live ingestion for affected competitors** until either the API
   access issue is resolved or an alternative collection path is validated
   end-to-end on a single test competitor before scaling.

4. **No schema, scoring, or ingestion code changes** until the fetch strategy
   is confirmed and a validated test proves end-to-end data retrieval works
   correctly for at least one real competitor.

---

## Files Added in This Diagnostic Phase

| File | Purpose |
|------|---------|
| `scripts/diagnose-meta-fetch.ts` | Phase 1 — parameter combination testing (8 tests) |
| `scripts/diagnose-meta-params.ts` | Phase 2 — parameter format testing (14 tests) |
| `docs/phase-7-meta-api-diagnostic-findings.md` | This document |

No production code was modified during this diagnostic phase.
`fetch.ts`, `types.ts`, `metaIngestion.ts`, schema, and scoring are unchanged
except for the `ad_type=ALL` fix committed separately, which is a correct
addition regardless of how the fetch strategy issue is resolved.
