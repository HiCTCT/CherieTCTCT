# Meta Ad Library Database — Project Status

**This document is the canonical source of truth for this project.**

It exists because work has been spread across multiple chats and coding agents, which caused
completed features, partial features, tests and deferred issues to be confused and repeated.
Every future chat and agent must read this document first and update it per section 20.

Primary evidence: independent read-only Codex audit at commit `6564b41`, cross-checked against
the tracked repository. Status is based on that evidence — **not** on the mere existence of code.

---

## 1. Product goal

The intended complete **local** workflow, end to end:

```
Competitor setup
  → browser discovery
  → validation
  → asset capture
  → verified metadata
  → creative analysis
  → saved analysis handoff
  → review and exceptions
  → database ingestion
  → dashboard and ad library
  → scan history
  → resumable refresh
  → local scheduling
```

Two permanent policies:

- **Browser-first collection is canonical.** The browser pipeline is the only trusted source of
  competitor ad inventory.
- **The Meta API is diagnostic only.** `docs/phase-7-meta-api-diagnostic-findings.md` records that
  competitor-specific API queries return empty and cannot be treated as a complete advertiser
  inventory. The API path exists, works, and writes records — it is still not canonical.

---

## 2. Current stable baseline

| Item | Value |
|---|---|
| Branch | `main` |
| Latest stable commit | `6564b41` |
| Commit title | `fix: harden multi-frame video analysis` |
| Application | Local-first Next.js 14 (App Router) |
| Database | Prisma ORM over SQLite (`prisma/dev.db`, local) |
| Collection policy | Browser-first canonical; Meta API diagnostic only |
| Canonical workflow ends at | **Terminal preview output only** — nothing is persisted |
| Ingestion path | **Separate**, and currently **repeats Vision analysis** rather than consuming the completed preview |

Working tree at time of writing: clean on tracked files; only the known protected untracked files
present (`AGENTS.md`, `dir`, `findstr`, `git`, `scripts/_orig_check.ts`).

---

## 3. Executive status

**What works today.** A local Next.js/Prisma app with live, database-backed pages for competitors,
industries, ads, stored analysis, captured evidence and a Meta-API review queue. A substantial
browser-first collection pipeline: discovery with scope proof and five-state classification,
CSV validation, asset capture for image/carousel/video, fail-closed footer provenance, and a
spend-guarded Vision preview with a no-spend preflight.

**Where the real end-to-end workflow stops.** At the terminal. `browser:preview` prints a full
report and exits. Nothing about that analysis is saved. To get data into the database you must run
`browser:ingest`, which **re-analyses the same assets by calling Anthropic again**.

**What is partial.** Competitor management (view/edit Meta config only), browser ingestion (writes
`Ad` + `AdAnalysis` but no run boundary), the review queue (Meta API only), the dashboard and ad
detail (live but not source-aware), `ScanRun` support (Meta only), and the one-command workflows
(discovery → preview only).

**The three largest structural gaps:**

1. **No reusable analysis bundle or validated handoff into ingestion.** Preview results, visual
   confidence and model output are never saved with source/asset checksums.
2. **No browser review and exception workflow.** The existing queue handles only Meta-API `PENDING`
   records. Browser `NEEDS_REVIEW`, `UNAVAILABLE`, low visual confidence and asset/copy mismatch are
   not persisted or reviewable.
3. **No browser `ScanRun` boundary, resumable orchestration or scheduler.** Discovery, capture,
   analysis, ingestion and card ingestion are not one recorded run.

**What should now be frozen rather than repeatedly retested.** Phase 0 discovery safety and scope
proof; HipVan/Castlery capped `PARTIAL_DISCOVERY`; Wellaholic canonical empty active scope; footer
provenance and raw-listing exclusion; image/carousel/video-frame capture; the multi-frame
planner/parser, exact-ID filter, spend gates and trigger hardening. See section 14.

---

## 4. Completed and sufficiently proven

Only features supported by repository evidence. **Frozen** = do not reopen without a specific,
demonstrated regression.

| Capability | Files / scripts | Commit | Validation evidence | Frozen? |
|---|---|---|---|---|
| Phase 0 browser discovery safety (5-state classification, exact final-URL scope proof, challenge detection, token-safe logging) | `scripts/create-browser-ads-csv-from-meta-page.ts`, `docs/browser-phase-0-measurement.md` | `7962dcc` | Documented complete in `CLAUDE.md`; manual Phase 0 runs | **Yes** |
| Capped partial-discovery handling (`MAX_ADS` ⇒ always `PARTIAL_DISCOVERY`, never a complete count) | same as above | `7962dcc` | HipVan + Castlery recorded as capped, scope-confirmed partials in `CLAUDE.md` | **Yes** |
| Canonical empty active scope (shared visible empty-results container + Clear Filters proof; never an inventory verdict) | `scripts/create-browser-ads-csv-from-meta-page.ts`, `scripts/phase0-browser-vs-api.ts` | `01099a6` | Wellaholic recorded in `CLAUDE.md` | **Yes** |
| Footer provenance (exact visible target Library-ID attribution; independent CTA/display/landing checks; cross-card contamination rejection) | `scripts/capture-browser-ad-assets.ts` | `46bd9e6` | Diagnostic proof output; `.verified-meta.csv` per-field ACCEPT/REVIEW/REJECT | **Yes** |
| Raw browser headline/description exclusion | discovery emits blanks; `scripts/capture-browser-ad-assets.ts` blanks `.with-assets.csv`; preview/ingest use only per-field `ACCEPT` | `3f3a76e` | Verified on the Castlery sample (0 non-blank rows) | **Yes** |
| Image capture | `captureImage()` in `scripts/capture-browser-ad-assets.ts` | pre-`46bd9e6` | Castlery/HipVan assets on disk | **Yes** |
| Carousel capture | `captureCarousel()` | pre-`46bd9e6` | Castlery carousels captured (3/5/8 cards) | **Yes** |
| Video-frame capture | `captureVideo()` | pre-`46bd9e6` | 4 frames per Castlery video ad | **Yes** |
| UNAVAILABLE vs NEEDS_REVIEW classification (positive ad-specific end-state only; technical failures ⇒ NEEDS_REVIEW) | `checkAdActive()` in `scripts/capture-browser-ad-assets.ts` | `d379f81` | Castlery `1227977176029398` correctly marked `UNAVAILABLE` | **Yes** |
| Creative-file allowlist (`image-`/`card-`/`frame-NN` only; debug/support excluded) | `isCreativeAssetFile()`, `planVisionInputs()` in `lib/analysis/creativeAssetAnalyser.ts` | `b45778a`, `22c6c7a` | Castlery preflight: eligible files dropped 32 → 22 once debug PNGs excluded | **Yes** |
| No-spend preview preflight | `computeAiWorkload()`, preflight path in `scripts/preview-browser-collected-ads.ts` | `b45778a` | Runs with no key; reports workload; makes no call | **Yes** |
| Paid confirmation + analysis cap (key + `AI_PREVIEW_CONFIRM_SPEND=I_UNDERSTAND` + `AI_PREVIEW_MAX_ANALYSES`, strict parsing, fail-closed) | `scripts/preview-browser-collected-ads.ts` | `b45778a` | Guard demonstrated failing closed with no key; cap variants (0/−1/1.5/junk) rejected | **Yes** (preview only — see §7) |
| Exact-ID preview filter (`AI_PREVIEW_ONLY_AD_IDS`, exact match, no substring) | `resolveOnlyAdIds()` | `22c6c7a` | Filtered preflight matched exactly 2 IDs; `1442273137905726` excluded | **Yes** |
| Numeric multi-frame ordering + `AI_VIDEO_MAX_FRAMES` (one request per ad) | `planVisionInputs()`, `analyseCreativeAsset()` | `22c6c7a`, `6564b41` | Preflight: all four video ads select 4 of 4 frames | **Yes** |
| Strict VIDEO response parsing (4 required sections, unique + ordered, non-empty bodies, exact `FRAME n:` observations, neutral malformed fallback) | `lib/analysis/creativeAssetAnalyser.ts` | `6564b41` | Synthetic assertions (see §18 caveat: **not tracked**) | **Yes** |
| Visual confidence **display** (HIGH/MEDIUM/LOW, fail-closed to LOW; separate from benchmark confidence) | parser + `scripts/preview-browser-collected-ads.ts` | `6564b41` | Terminal display only — **not persisted** (see §5, §8) | Display frozen; persistence outstanding |
| Deterministic behavioural-trigger hardening (evidence-required urgency / before-after / fear-of-loss / status / belonging) | `detectBehaviouralTriggers()` in `lib/analysis/scoring.ts` | `22c6c7a`, `6564b41` | Synthetic assertions (**not tracked**); triggers affect output only, not numeric scores | **Yes** |
| TypeScript validation | `npx tsc --noEmit` | ongoing | Passing at `6564b41` | Run on every change |

**Explicitly not claimed:** paid Vision **output quality** is not universally proven. Generated
preview output is untracked, so specific paid run counts and descriptions are not reproducible from
this repository. See §10 and §18.

---

## 5. Built but partial

| Feature | What works | What is missing | Exact files | Blocks local v1? | Deferrable after v1? |
|---|---|---|---|---|---|
| Competitor management | List, detail, Meta readiness, counts, last scan; CSV importer; PATCH edit of Facebook URL + Meta Page ID | No UI/API create; no edit of name/client/industry/status; no **country** field; no active/archive semantics; no frequency/next-scan; no delete/archive | `app/competitors/page.tsx`, `app/competitors/[id]/page.tsx`, `app/components/CompetitorMetaConfigForm.tsx`, `app/api/competitors/[id]/meta-config/route.ts`, `scripts/import-client-competitors.ts`, `prisma/schema.prisma` | Country + scheduling block Phase 5, not Phase 1 | Yes |
| Browser ingestion | Per-row transaction inserting `Ad` + `AdAnalysis`; triple-flag live-write guard; duplicate isolation; verified-ACCEPT-only headline/description | Calls Anthropic again (incl. dry-run, before dedup); no `ScanRun`; no exact include/exclude IDs; no spend cap/confirmation; discards visual confidence and verification reasons | `scripts/ingest-browser-collected-ads.ts` | **Yes — this is the primary gap** | No |
| Meta review queue | `/meta-review` lists Meta `PENDING`; approve/reject persists `reviewStatus` + `qualified`; server-side score check | Meta-API only; no browser ads; no note/reviewer/timestamp/override; no ingestion gate | `app/meta-review/page.tsx`, `lib/queries/pendingAds.ts`, `app/api/ads/[id]/review/route.ts` | **Yes** (Phase 2) | No |
| Dashboard + ad detail | Live Prisma queries; filters (industry, qualified, source, format, score, search); full stored analysis, AIDA, triggers, benchmark, asset gallery, card grid | Dashboard defaults to all ads incl. pending/rejected; no visual-confidence display; no review actions; no provenance labels | `app/page.tsx`, `app/ads/[id]/page.tsx`, `app/components/DashboardFilter.tsx` | No | Yes (Phase 4) |
| ScanRun support | Schema models exist (`ScanRun`, `AdScanRecord`); Meta ingestion + seed create and complete runs; `getScanRunById()` exists | Browser ingestion creates **none** (verified: 0 references); no run-detail page; removed/skipped/capture/analysis counts absent; a failure can leave a run `IN_PROGRESS` | `prisma/schema.prisma`, `lib/ingestion/metaIngestion.ts`, `lib/queries/scanRuns.ts`, `scripts/ingest-browser-collected-ads.ts` | **Yes** (Phase 3) | No |
| One-command browser workflows | `browser:workflow-one` / `workflow-db-one` / `workflow-client` chain discovery → validate → capture → validate → preview; continue-on-failure across competitors | No validation decision, ingestion, cards or display stage; no durable checkpoint/resume; preview can print FAIL without a non-zero exit when row errors are collected | `scripts/run-one-competitor-browser-workflow.ts`, `run-db-competitor-browser-workflow.ts`, `run-client-browser-workflow.ts` | Phase 5 | Yes |
| Asset / card ingestion | `browser:ingest-cards` upserts `AdCreativeCard` idempotently by `(adId, cardIndex)`; FK-safe (never creates Ads) | Separate command, not part of one atomic run; card text not re-gated against verified-meta ACCEPT | `scripts/ingest-ad-creative-cards.ts` | Phase 3 | Yes |
| Visual-confidence persistence | Parsed and displayed in preview | Not in Prisma, not in a bundle, not in the review queue, not in ad UI; ingestion discards it | `lib/analysis/creativeAssetAnalyser.ts`, `scripts/preview-browser-collected-ads.ts` | Phase 1/2 | Partly |
| Verified-metadata provenance persistence | `.verified-meta.csv` holds per-field status + reason + strategy; only ACCEPT reaches `Ad` | Status/reason never stored in DB, so the UI cannot show why a field is blank | `scripts/capture-browser-ad-assets.ts`, `scripts/ingest-browser-collected-ads.ts` | Phase 3 | Yes |

---

## 6. Existing review and exception handling

**A review queue already exists.** It is at **`/meta-review`** and it is a **Meta API pending-ad
approval queue**. It is **not** the browser quality/exception queue the canonical workflow needs.
Do not rebuild it — extend or generalise it.

Existing implementation:

- **Route:** `app/meta-review/page.tsx` — supports a `competitorId` filter.
- **Queries:** `lib/queries/pendingAds.ts` — `getPendingAds()` filters `adSource: 'meta_api'`
  (verified at lines 27 and 54) **and** `reviewStatus: 'PENDING'`.
- **API action:** `POST app/api/ads/[id]/review/route.ts` — APPROVE/REJECT. It **rejects any
  non-`meta_api` ad** (verified at line 67). Server enforces the score rule (≥ 7.0 ⇒ `qualified=true`)
  and never trusts a client-supplied score.
- **Effect:** persists `Ad.reviewStatus` and `Ad.qualified`; reviewed ads leave the queue.

### State matrix

| State | Current representation | Where it exists | Persisted? | Visible in UI? | Affects ingestion? | Remaining work |
|---|---|---|---|---|---|---|
| **ACCEPTED** | Named `APPROVED` | `Ad.reviewStatus` via `/meta-review` | **Yes** | Yes — Meta ads only | Sets `qualified` from score; does **not** gate browser ingestion | Make source-neutral; gate ingestion on the decision |
| **NEEDS_REVIEW** | CSV `collection_status` only | `.with-assets.csv`; capture writes it for technical/uncertain failures | **No** (CSV only) | No | Indirectly — skipped because ingestion is READY-only | Persist as a DB review state; surface in a queue |
| **UNAVAILABLE** | CSV `collection_status` only | Capture writes it on positive ad-specific end-state | **No** (CSV only) | No | Indirectly — skipped (READY-only) | Persist; show as an exception, not silent skip |
| **ASSET_COPY_MISMATCH** | **Not implemented** | Nowhere | No | No | No | Define detector, schema field, queue filter and ingestion gate |
| **MISSING_ANALYSIS** | Only implicit (`Ad.analysis = null`) | Ad detail shows fallback text | Implicitly | Fallback text only | No | Name the state; add a queue |
| **LOW_VISUAL_CONFIDENCE** | Terminal display only | Video parser returns HIGH/MEDIUM/LOW | **No** | Preview terminal only | **No** | Persist; route LOW to review. Note: `benchmarkConfidence=LOW` is a **different** concept (evidence source, not visual certainty) |

### Recorded inconsistency (verified)

Browser ingestion inserts `reviewStatus: 'PENDING'` (line 860) while setting `qualified` directly
from analysis (line 862). Because `/meta-review` rejects non-`meta_api` ads, **a browser ad can be
simultaneously `PENDING` and `qualified`, with no available review action.** This must be resolved in
Phase 2 — either by a source-neutral queue or by an explicit browser decision lifecycle.

---

## 7. Analysis reuse and repeated-charge risk

**This is the immediate architectural priority.**

Verified problems:

- Preview results are **printed only** — never saved.
- Visual confidence is **transient** — parsed, displayed, discarded.
- **No bundle, checksum or saved analysis artifact exists** anywhere in the repository.
- `scripts/ingest-browser-collected-ads.ts` invokes `resolveCreativeContext()` again
  (**line 695**), which calls Anthropic Vision for every asset-backed row.
- **Dry-run ingestion still calls Anthropic.** The three live-write flags gate DB writes, not spend.
- **Scoring runs before duplicate detection** — `resolveCreativeContext()` at line 695 precedes the
  dedup query `prisma.ad.findMany` at **line 756**. An ad already in the database can therefore
  **incur another Vision charge before being skipped as a duplicate**.
- Browser ingestion has **no** preview-style spend confirmation, cap or exact-ID filter.

Consequence: the same assets are paid for at least twice, and there is no way to move a reviewed,
validated analysis into the database without re-spending. Phase 1 closes this.

---

## 8. Database and ingestion status

### Browser ingestion currently writes

- **`Ad`** — `primaryCopy` (contamination-filtered raw ad copy), verified-ACCEPT `headline` /
  `description`, `adFormat`, `metaAdId`, `adSource='browser_collected'`, lifecycle fields
  (`firstSeenAt`, `lastSeenAt`, `lastSeenActiveAt`, `adStatus='ACTIVE'`), `capturedAssetPath` /
  `capturedAssetType`, `score` / `qualified`, and benchmark fields
  (`competitorBenchmarkScore`, `benchmarkTier`, `benchmarkConfidence`, `evidenceSource`,
  `creativeSource`, `benchmarkScoredAt`).
- **`AdAnalysis`** — component sub-scores, AIDA, behavioural triggers, recommendations, final
  verdict, benchmark breakdown JSON.

### It does **not** write

- A browser **`ScanRun`** (verified: **0** `scanRun` references in the script).
- **`AdScanRecord`** for the browser workflow.
- **Visual confidence.**
- **Verified-metadata decision reasons** (status/reason/strategy are lost).
- **Browser exception reasons.**
- **Analysis bundle provenance**, model version or checksums.
- **`AdCreativeCard`** within the same atomic workflow (`browser:ingest-cards` is separate).

### Safeguards (current)

- Dry-run is the default and performs **DB reads only, no writes** — but **still performs AI
  analysis** (the key gap in §7).
- Live writes require **all three** flags: `BROWSER_DRY_RUN=false` + `BROWSER_INGEST_WRITE=true` +
  `BROWSER_INGEST_CONFIRM_DB_WRITES=I_UNDERSTAND`.
- Each ad + analysis pair is written in one transaction; duplicate/write failures are isolated per row.
- No updates or deletes in the main browser ingestion path.
- Mixed-competitor guard aborts if READY rows span multiple `meta_page_id`s.
- **Database backup is an operator instruction, not an enforced prerequisite.**
- Meta ingestion creates `ScanRun`/`AdScanRecord` but does not mark a started run `FAILED` on
  exception, so a run can be stranded `IN_PROGRESS`.

---

## 9. Existing UI

All pages below are **Prisma-backed and live** — none is a static mock (a seeded dev database may
supply the data).

| Route | State | Data source | Remaining work |
|---|---|---|---|
| `/` | Live, partial | `getDashboardCounts()`, `getAllIndustriesForFilter()`, `getAllAds()` | Defaults to **all** ads incl. pending/rejected; not source-aware/curated |
| `/competitors` | Live, partial | `getCompetitors()` | No create/archive; no schedule controls |
| `/competitors/[id]` | Live, partial | `getCompetitorById()`, `getCompetitorWithScanHistory()`, `getPendingAdCount()`, `getCompetitorAdsRanked()` | Meta config edit only; scan history has no run-detail link |
| `/industries` | Live | `getIndustries()` | — |
| `/industries/[slug]` | Live | `getIndustryBySlug()` | Qualified-only ads |
| `/ads/[id]` | Live, partial | `getAdById()` incl. `AdAnalysis` + `AdCreativeCard` | No visual-confidence display; no review actions; no provenance labels; video is still-frames only |
| `/meta-review` | Live, **narrow** | `getPendingAds()` — `adSource='meta_api'` + `PENDING` | Meta-only; see §6 |
| `GET /api/ads` | Live, partial | `getAds()` | No review-status filter |
| `POST /api/ads/[id]/review` | Live, **narrow** | `db.ad.update()` | Rejects non-`meta_api` (line 67) |
| `PATCH /api/competitors/[id]/meta-config` | Live, narrow | `updateCompetitorMetaConfig()` | Facebook URL + Meta Page ID only |
| `GET /api/captured-asset` | Live | Filesystem, path-traversal guarded | — |

**Missing UI:** dedicated `/ads` list page (the dashboard serves this role; some CLI output
references `/ads`, which does not exist); browser review/exception queue; scan-run detail page
(despite `getScanRunById()` existing); add/full-edit/archive competitor; scheduler controls;
analysis-run/bundle history; route-level error boundaries (`app/error.tsx`); explicit metadata
verification labels; real video playback.

---

## 10. Known limitations and deferred bugs

**All of the following are DEFERRED. None blocks building the rest of the architecture.**

- **Imperfect AI interpretation of individual video samples.** The model can over-weight the first
  frame or misidentify the subject. Mitigated at `6564b41` (labelled frames, mandatory per-frame
  method, LOW-confidence path) but **not proven fixed** — proving it requires paid runs.
- **Only sampled video frames are analysed** — up to `AI_VIDEO_MAX_FRAMES` stills. No continuous
  video, motion or audio/transcript interpretation.
- **Visual confidence is not persisted** — display only.
- **Limited competitor editing** — Meta config only; no country, status, schedule or archive.
- **Incomplete retry/resume** — one zero-card discovery reload and forced recapture exist; no
  bounded automatic capture retry policy; no durable checkpoint.
- **No browser review queue** (§6).
- **No automatic scheduler** — the GitHub workflow is `workflow_dispatch` only, cron commented out
  (`.github/workflows/meta-batch-weekly.yml:23`), and it refuses a local SQLite `DATABASE_URL`.
- **Benchmark "HIGH confidence" means ASSET evidence, not visual certainty** — a naming hazard.
- **No tracked automated tests** (no test script, no `*.test.ts`).

> **Individual Vision-description quality tuning is deferred until the complete local v1
> architecture is functional. Do not resume paid Vision testing during the current build phase.**
> Paid runs before analysis reuse (Phase 1) and review persistence (Phase 2) exist would re-spend on
> every iteration and cannot be captured or reviewed.

---

## 11. Remaining build phases

Shortest non-duplicative sequence to complete local v1. Phases already complete are not listed.

### Phase 1 — Reusable analysis handoff  ← **ACTIVE**

- **Objective:** make a completed preview a durable, validated ingestion input.
- **Work remaining:** versioned analysis bundle (JSON), source CSV checksum, per-asset checksums,
  strict validator, and zero-AI ingestion reuse.
- **Likely files:** new `lib/analysis/browserAnalysisBundle.ts`; `scripts/preview-browser-collected-ads.ts`;
  `scripts/ingest-browser-collected-ads.ts`; `lib/analysis/creativeAssetAnalyser.ts` (version constants only).
- **Dependencies:** existing planner/parser and exact-ID filter (both complete).
- **Completion criteria:** preview can explicitly save a validated result; ingestion can consume it;
  a matching valid bundle causes **zero** Anthropic calls; stale/mismatched bundles fail closed;
  exact selected ad IDs recorded; deterministic scores and visual confidence preserved.
- **Validation:** tracked unit tests for schema, checksum drift, duplicate/missing IDs, unchanged scoring.
- **Deferred:** all paid quality tuning; schema changes.

### Phase 2 — Browser review and exception state

- **Objective:** extend the narrow Meta-only review design into a source-neutral review/exception workflow.
- **Work remaining:** persisted accepted/excluded decisions; exception reasons; note, review time and
  reviewer attribution; routing for LOW visual confidence and asset/copy mismatch; ingestion eligibility gate.
- **Likely files:** `prisma/schema.prisma` + migration; new review queries/page/API; bundle validator;
  ingestion eligibility logic. **Extend `/meta-review` or add `app/review` — do not rebuild it.**
- **Dependencies:** Phase 1 bundle; stable ad/run identity.
- **Completion criteria:** decisions persist and survive reload; valid ads proceed while held ads stay
  queued; decisions control ingestion; the §6 PENDING-but-qualified inconsistency is resolved.
- **Validation:** route/state-transition tests; UI smoke tests.
- **Deferred:** full manual analysis editing — start with accept / exclude / note.

### Phase 3 — Browser ScanRun and atomic ingestion

- **Objective:** record one auditable browser ingestion run.
- **Work remaining:** browser `ScanRun` + `AdScanRecord`; accepted/held/skipped/duplicate/failed counts;
  structured errors; `FAILED` on exception; same-run card ingestion.
- **Likely files:** `prisma/schema.prisma`, `scripts/ingest-browser-collected-ads.ts`,
  `scripts/ingest-ad-creative-cards.ts`, `lib/queries/scanRuns.ts`.
- **Dependencies:** Phases 1–2.
- **Completion criteria:** one run records every outcome; `Ad`, `AdAnalysis`, captured evidence and
  cards written in the appropriate run; failures isolated; **no repeated AI call**.
- **Validation:** dry-run fixtures; temporary-database integration tests.
- **Deferred:** automatic inactive reconciliation.

### Phase 4 — Operational UI

- **Objective:** expose the canonical workflow in the application.
- **Work remaining:** browser review/exception page; scan-run detail page; visual-confidence and
  verified-metadata provenance display; source-aware filters; navigation between competitor → run →
  review item → ad.
- **Likely files:** new `app/review` (or expanded `/meta-review`), new `app/scan-runs/[id]`,
  `app/ads/[id]/page.tsx`, `app/competitors/[id]/page.tsx`.
- **Dependencies:** stored states from Phases 1–3.
- **Completion criteria:** an operator can review a run, inspect evidence, accept/exclude ads and
  navigate to ingested results.
- **Validation:** UI smoke tests against fixture data.
- **Deferred:** one-click paid execution from the browser.

### Phase 5 — Resumable workflow and scheduling

- **Objective:** connect and safely resume discover → capture → analyse → review → ingest → display.
- **Work remaining:** durable stage state; resume; lock; duplicate-run prevention; competitor
  **country**, active/archive and frequency configuration; scheduler wrapper.
- **Likely files:** new browser workflow orchestrator; `prisma/schema.prisma` + competitor config UI;
  scheduler wrapper.
- **Dependencies:** all prior phases.
- **Completion criteria:** the chain can stop and resume **without repeating completed or paid stages**.
- **Validation:** failure-injection and restart tests.
- **Deferred:** automatic cron / Windows Task Scheduler until the manual local workflow is proven.
  Local-first is recommended: the existing GitHub workflow refuses a local SQLite database, so hosted
  automation would first require a separate hosted-database decision.

---

## 12. Active phase

> ### ACTIVE: **Phase 1 — Reusable analysis handoff**

Browser collection and Vision prompt quality are **frozen** unless a concrete regression blocks
implementation.

- **Goal:** a versioned, checksum-validated browser-analysis bundle that ingestion consumes with
  zero Anthropic calls.
- **Files likely involved:** new `lib/analysis/browserAnalysisBundle.ts`;
  `scripts/preview-browser-collected-ads.ts`; `scripts/ingest-browser-collected-ads.ts`.
- **Boundaries:** no Prisma/schema change yet; no DB writes; no paid calls; no browser runs; no
  capture or prompt changes.
- **Validation:** `npx tsc --noEmit`; `git diff --check`; no-spend preflights unchanged; tracked unit
  tests for the bundle schema/validator.
- **Expected output:** a saved bundle file plus a bundle-backed ingestion **planning** path that
  provably makes no external call.

---

## 13. Next exact task

**Implement a versioned browser-analysis bundle and strict validator, then make browser ingestion
plan from that bundle with zero Anthropic calls.**

Scope:

- A new module (e.g. `lib/analysis/browserAnalysisBundle.ts`) defining a **versioned** bundle schema:
  - bundle/schema version;
  - **source CSV checksum**;
  - **exact selected Library IDs**;
  - **eligible asset filenames + checksums**;
  - **model, prompt and planner version**;
  - per-ad **visual description**, **creative notes**, **visual confidence**;
  - deterministic **scores** and **benchmark result**.
- An explicit preview output file (opt-in, off by default) that writes the bundle after a successful run.
- A **strict, fail-closed validator**: unknown/missing version, checksum drift (source or asset),
  duplicate IDs, missing IDs, or malformed structure ⇒ reject; never partially trust.
- A **bundle-backed ingestion planning path** that consumes a valid bundle and performs **zero**
  external calls (verified by not importing/invoking `resolveCreativeContext()` on that path).

The task must **not**:

- reopen video-prompt or Vision quality tuning;
- call Anthropic;
- run browser discovery or capture;
- write to the database;
- change the Prisma schema yet;
- stage, commit or push without separate approval.

Validation: `npx tsc --noEmit`; `git diff --check`; tracked unit tests for the validator; both
no-spend Castlery preflights unchanged.

---

## 14. Do-not-repeat list

**Do not reopen, retest or rebuild the following without a specific, demonstrated regression.**

- Phase 0 advertiser expansion or additional theoretical discovery states.
- HipVan / Castlery capped partial-discovery proof.
- Wellaholic canonical empty active-scope proof.
- Meta API completeness testing or broad-keyword fallback experiments.
- Footer-provenance experiments.
- Raw browser listing headline/description exclusion.
- Basic image / carousel / video-frame extraction.
- One-frame vs multi-frame request construction — the implementation is **already multi-frame**.
- Exact-ID preview filtering.
- No-spend preflight.
- Preview spending cap and paid-confirmation design.
- Repeated paid tuning of individual video descriptions.
- Behavioural-trigger tuning via paid reruns.

---

## 15. Safety and Git rules

Summarised from tracked `CLAUDE.md` — these are binding:

- **Browser-first collection is canonical.** The **Meta API is diagnostic only** and must never be
  presented as a complete advertiser inventory.
- **Blank is safer than unverified metadata.** Browser listing `headline`/`description` must always
  remain blank; exact creative metadata is stored only when independently proven to belong to the
  same ad card and the target Library ID. Never infer, rewrite or borrow from adjacent Meta UI.
- **Never use `git add .`.** Stage only explicitly named files.
- **Never commit or push** without explicit approval **in the current message**.
- **Never delete, clean, restore, rename or modify untracked files** without explicit approval.
  Protected untracked files: `dir`, `findstr`, `git`, `scripts/_orig_check.ts` (and `AGENTS.md`,
  `.claude/settings.local.json`).
- Do **not** stage generated CSVs, logs, reports, assets, databases or backups.
- **No unapproved paid API, browser, database, Prisma, migration, schema or scheduler operation.**
  Each exact command needs approval. Never write to the database during Phase 0 work.
- **Never inspect, print, echo, log or request API tokens, credentials or secrets.**
- A capped discovery sample is never a complete inventory; zero ads in an exact country/active/all
  scope is never an inventory verdict.

Working method: state task type, exact files affected, exact validation commands, and whether
staging/commit/push is needed. Default to read-only review and plan before editing. Stop after
validation unless the next step is explicitly approved.

---

## 16. Agent roles

| Agent | Role |
|---|---|
| **Claude Code** | Main implementation agent. Writes code, runs local validation, updates this document. |
| **Codex** | Independent **read-only** reviewer at major checkpoints. Does not implement. |
| **ChatGPT project chat** | Planning, coordination and approval sequencing. |

> **Two coding agents must never edit the same files simultaneously.** Before starting, confirm no
> other agent holds the files named in the active phase. Codex reviews are read-only and may run
> concurrently; implementation must not.

---

## 17. Completed-build timeline

Repo-grounded descriptions (from diffs, not commit titles):

| Commit | Actual change |
|---|---|
| `46bd9e6` | Reworked footer extraction around exact, visible target Library-ID attribution. CTA, display URL and landing URL gained independent provenance checks, cross-card contamination rejection and diagnostic proof output. |
| `7962dcc` | Added Phase 0 discovery-run logging and five-state classification, exact scope diagnostics, challenge detection, token-safe logging, local capture measurement, and browser-vs-API comparison tooling/documentation. |
| `01099a6` | Added a separate canonical-empty-active-scope proof requiring the full visible empty-results container and Clear Filters evidence; integrated into discovery status and diagnostic comparison **without** becoming a global no-ads claim. |
| `74789e7` | Added tracked `CLAUDE.md` project/data/Git/live-run rules. Documentation and operating policy — not runtime functionality. |
| `3f3a76e` | Forced raw browser-listing headline and description blank when serialising `.with-assets.csv`. |
| `d379f81` | Restricted `UNAVAILABLE` to explicit ad-specific end-state phrases; technical, navigation and uncertain capture failures now become `NEEDS_REVIEW`. |
| `b45778a` | Added the shared creative-file allowlist, no-spend workload preflight, strict maximum-analysis parsing, whole-batch eligibility gate and explicit paid-spend confirmation. |
| `22c6c7a` | Added numeric multi-frame video planning, `AI_VIDEO_MAX_FRAMES`, shared preflight/payload planning, exact numeric ID filtering, and tightened deterministic behavioural-trigger rules. |
| `6564b41` | Added labelled frame/image request blocks, strict four-section video parsing, exact frame-observation validation, neutral malformed-response fallback, video visual confidence, and distinct preview labels for visual vs benchmark confidence. |

---

## 18. Validation log

Evidence classes: **repo-verifiable** · **manually documented** · **synthetic (not tracked)** ·
**not yet verified**. Where an exact date is not proven, the commit hash is used.

| Date / Commit | Phase | Validation | Result | Notes |
|---|---|---|---|---|
| `7962dcc` | Phase 0 | Browser discovery safety, 5-state classification, scope proof | PASS | **Manually documented** in `CLAUDE.md` / `docs/browser-phase-0-measurement.md` |
| `7962dcc` | Phase 0 | HipVan — capped, scope-confirmed `PARTIAL_DISCOVERY` | PASS | **Manually documented** |
| `7962dcc` | Phase 0 | Castlery — capped, scope-confirmed `PARTIAL_DISCOVERY` | PASS | **Manually documented** |
| `01099a6` | Phase 0 | Wellaholic — canonical empty active scope (not "no ads anywhere") | PASS | **Manually documented** |
| `46bd9e6` | Capture | Ad-level footer provenance, exact Library-ID attribution | PASS | **Manually documented**; `.verified-meta.csv` evidence |
| Phase 7 doc | Meta API | Competitor-specific API queries return empty | FAIL (API ruled out) | **Repo-verifiable** — `docs/phase-7-meta-api-diagnostic-findings.md` |
| `3f3a76e` | Capture | Raw listing headline/description blanked in `.with-assets.csv` | PASS | **Repo-verifiable** code; sample showed 0 non-blank rows |
| `d379f81` | Capture | `UNAVAILABLE` only on positive ad-specific evidence | PASS | Castlery `1227977176029398` marked `UNAVAILABLE` |
| `b45778a` | AI gating | No-spend preflight; cap + paid confirmation fail closed | PASS | Preflight runs with no key and makes no call |
| `22c6c7a` | AI gating | Exact-ID filter; multi-frame planning; trigger hardening | PASS | Preflight: 2 IDs matched exactly; 4-of-4 frames per video |
| `6564b41` | AI parsing | Strict VIDEO section/frame validation; malformed fallback | PASS | **Synthetic (not tracked)** — assertions ran in-session only |
| `6564b41` | Repo | `npx tsc --noEmit` | PASS | **Repo-verifiable** |
| `6564b41` | Repo | `git diff --check` | PASS | **Repo-verifiable** |
| — | AI quality | Paid Vision output quality / run counts | **Not yet verified** | Generated preview output is untracked and not reproducible from this repo |
| — | Ingestion | Live browser ingestion against the database | **Not yet verified** | Never run |
| — | Ingestion | Card ingestion inside one atomic run | **Not yet verified** | Not implemented |
| — | Review | Browser review states | **Not yet verified** | Do not exist |
| — | Scheduler | Scheduled execution | **Not yet verified** | Cron disabled |
| — | Tests | Automated test suite | **Missing** | No test script or tracked spec files |

---

## 19. Append-only change log

**Append new rows at the bottom. Never rewrite history.**

| Date | Commit | What changed | What became complete | What remains |
|---|---|---|---|---|
| 2026-07-16 | `6564b41` | Baseline recorded. Multi-frame video hardening: labelled frame blocks, strict four-section parsing, exact frame-observation validation, neutral malformed fallback, visual confidence display. | Strict VIDEO response parsing; visual-confidence **display**; frame-observation validation | Analysis bundle + reuse (Phase 1); browser review/exceptions (Phase 2); browser `ScanRun` (Phase 3); operational UI (Phase 4); resume + scheduling (Phase 5) |
| 2026-07-16 | (uncommitted) | Created `docs/PROJECT_STATUS.md` as the canonical tracker from the independent Codex audit. | Single source of truth for status, phases, do-not-repeat and agent roles | Phase 1 implementation |

---

## 20. End-of-task update rule

> **Permanent instruction.**
>
> At the end of **every** completed implementation task, the main coding agent **must update
> `docs/PROJECT_STATUS.md` before staging**, or explicitly explain why no status change is required.
>
> Every update must record:
>
> - **files changed**;
> - **validation performed**;
> - **approved commit** (after approval);
> - **active phase status**;
> - **next task**;
> - **deferred issues discovered**.
>
> **No agent may change the active phase merely because it found a quality bug.** The active phase
> changes only when the stated completion criteria are satisfied, or when the user explicitly
> reprioritises it. Quality bugs are recorded in §10 (Known limitations and deferred bugs) and, if
> relevant, §19 (change log) — they do not reopen frozen work (§14).
