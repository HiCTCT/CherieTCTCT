# Meta Ad Library Database — Project Status

**This document is the canonical source of truth for this project.**

It exists because work has been spread across multiple chats and coding agents, which caused
completed features, partial features, tests and deferred issues to be confused and repeated.
Every future chat and agent must read this document first and update it per section 20.

Primary evidence: independent read-only Codex audit at commit `6564b41`, cross-checked against
the tracked repository. Status is based on that evidence — **not** on the mere existence of code.

---

## 0. Session handover — READ FIRST

_Last updated: 2026-07-17. Written after Phase 1 part 1 was reviewed (**Codex PASS**), committed and
**pushed to `origin/main`**. Nothing is pending for Part 1._

### 0.1 What is complete

- **Frozen and proven** (see §4, §14): Phase 0 discovery safety, capped `PARTIAL_DISCOVERY`, canonical
  empty active scope, footer provenance, raw headline/description exclusion, image/carousel/video-frame
  capture, UNAVAILABLE-vs-NEEDS_REVIEW classification, creative-file allowlist, no-spend preflight,
  paid confirmation + analysis cap, exact-ID preview filter, numeric multi-frame ordering, strict VIDEO
  parsing, visual-confidence **display**, deterministic trigger hardening.
- **Committed and pushed in earlier sessions:** `74789e7`, `3f3a76e`, `d379f81`, `b45778a`, `22c6c7a`,
  `6564b41`, `c69866a`.
- **Committed and pushed on 2026-07-17:** `3cedf83` (Phase 1 part 1 implementation) and `e208cbd`
  (tracker recording the final Codex PASS). `origin/main` contains both; local `main` was verified
  **level with `origin/main`** after the push.
- **Phase 1 part 1 — reviewed, committed and pushed. COMPLETE and FROZEN (§14):** versioned bundle
  (schema **v2**), strict fail-closed validator, bundle-backed **no-write planner**, opt-in preview
  bundle output, and **153 tracked tests passing**. Three review rounds ran in all: the first review,
  then the final review (**NEEDS CHANGES**, six findings), then the focused re-review (**NEEDS CHANGES**,
  three narrower findings — an empty-`creative_asset_path` ASSET bypass and two atomic-write reporting
  qualifications). Every finding was corrected, and the **final minimal Codex re-review returned PASS**
  before the commit (§18). **Nothing is pending for Part 1: no further review, no further commit, no
  further push.** Details in §11 Phase 1. Its safeguards are now on the frozen do-not-repeat list (§14)
  and must not be reopened without a specific, demonstrated regression.

### 0.2 What is currently being worked on

**Phase 1 — Reusable analysis handoff** (§12). Part 1 is:

- implemented, with both the final Codex review's six findings and the focused re-review's three
  findings corrected;
- **independently reviewed: the final minimal Codex re-review returned PASS** (§18) — 153 tests passed,
  0 failed, 0 skipped; TypeScript passed; `git diff --check` passed; the ASSET empty-path bypass
  resolved; temp cleanup correctly treated as best-effort; final checksum and byte-size verification
  fails closed; the zero-AI / zero-browser / zero-database boundary passed. Part 1 was declared **safe to
  commit**;
- **committed as `3cedf83`** and **pushed to `origin/main`** on 2026-07-17, together with the tracker
  commit `e208cbd`; local `main` verified level with `origin/main` afterwards;
- **153 tracked tests passing** (87 → 139 → 153 as each correction added regression tests);
- **DONE. Nothing is pending for Part 1** — no review, no commit, no push.

**Phase 1 itself is NOT complete, and remains ACTIVE and partial (§11, §12).** Part 1 built the reusable
handoff; **part 2 has not started**. Specifically:

1. `scripts/ingest-browser-collected-ads.ts` is **not bundle-backed**;
2. live ingestion still calls `resolveCreativeContext()` (line 695) **before** duplicate detection
   (line 756), so it **can still repeat paid AI analysis** — including on dry runs;
3. **no reusable bundle produced by a real paid preview exists** — every bundle exercised so far is
   synthetic, or built from real assets with placeholder analysis text.

**The immediate action is the next implementation task in §0.4/§13, which requires its own explicit
instruction. Do not start it merely because this tracker names it.**

### 0.3 What is blocked

| Blocked item | Reason | Unblocks when |
|---|---|---|
| Paid Vision preview **from a Claude Code session** (checkpoint **A1**) | `ANTHROPIC_API_KEY` is **ABSENT** from the environment this session inherits. Verified three times. The script reads `process.env` directly — no dotenv loader — so a `.env` file will not work. *(The operator has separately run bounded paid previews from Windows Command Prompt, where the key is available — see §0.6.)* | The key is set at OS/user level **and a new session is started** so the shell inherits it — or the operator runs it from Command Prompt. |
| A **bundle produced by a real paid preview** | Earlier paid runs were terminal-only and predate the bundle writer, so none produced a bundle. Every bundle exercised so far is synthetic, or built from real assets with **placeholder** analysis text. | After a paid preview is run with `AI_PREVIEW_OUTPUT_FILE` set (post-review). |
| Live browser DB ingestion (checkpoint **A2**) | Not approved, and `browser:ingest` still calls Anthropic before dedup. | After the next task + explicit approval. |
| ~~Committing Phase 1 part 1~~ | **DONE — the final Codex re-review returned PASS, then the operator approved the commit. Committed as `3cedf83` on 2026-07-17.** | Done. |
| ~~Pushing `3cedf83` + `e208cbd` to `origin/main`~~ | **DONE — pushed 2026-07-17 (`c69866a..e208cbd`, fast-forward). `origin/main` contains both commits; local `main` verified level.** | Done. |
| ~~Freezing Phase 1 part 1 on the do-not-repeat list (§14)~~ | **DONE — §14 requires a Codex PASS **and** a committed, pushed change. PASS ✅, committed ✅, pushed ✅. Moved to the frozen list.** | Done. |

**Nothing in Phase 1 part 1 is blocked or pending.** The remaining blocked items above belong to Phase 1
part 2 and later phases.

### 0.4 The next exact task

> **Integrate the validated reusable analysis bundle into the real browser-ingestion path, so ingestion
> can reuse approved analysis without another Anthropic call.**

Phase 1 part 1 is **finished, reviewed, committed and pushed** — nothing about it is pending. This is
**part 2**, and it is the next *implementation* task, not an authorisation to start: it **requires its own
separate explicit task instruction.** Do not begin it because this tracker names it. The full spec is §13.

**Required boundary for that task, when it is instructed:**

- **No second AI analysis.** A validated bundle is the only source of analysis; there is **no recompute
  fallback** — missing bundle → fail, invalid or stale bundle → fail, missing row → REVIEW.
- **Validate the bundle and source identity BEFORE planning any write** — reuse `loadBundle()`,
  `bundleRowIdentity()` and `sourceRowIdentityMismatch()`; fail closed on any drift.
- **Deduplicate before any optional external work**, so a duplicate can never incur a charge first. This
  is the exact defect today: `resolveCreativeContext()` at line 695 runs *before* the `prisma.ad.findMany`
  dedup at line 756.
- **Preserve per-row REVIEW/ERROR isolation** — one held or failed row must never block another valid row.
- **No database write as part of tracker or planning work.** Keep the triple-flag live-write guard,
  READY-only eligibility and verified-ACCEPT-only metadata. No Prisma/schema change.
- Add tracked tests for the new ingestion path.

Sequence already completed for part 1 — do not repeat or reorder:

1. ~~Codex review of the corrected code~~ — **done**: verdict **NEEDS CHANGES**, six findings.
2. ~~Correct those findings~~ — **done** (§19). Temp-file-only bundle writes with atomic no-clobber
   finalisation; sensitive-string checks on `analysis_model`; no silent blank-source-ID filter in the
   planner; requested bundle output for held-only scopes; VIDEO manifest cardinality;
   `creative_asset_path` containment with an empty manifest; standalone validator source-row completeness.
3. ~~Focused Codex re-review~~ — **done**: verdict **NEEDS CHANGES**, three narrower findings — ASSET
   SUCCESS rows could still declare an empty `creative_asset_path` and bypass asset disk validation;
   temp-cleanup failures were silently suppressed while cleanup was described as unconditional; a final
   `stat` failure could return success with `bytes: 0`.
4. ~~Correct those three~~ — **done** (§19).
5. ~~Final minimal Codex re-review of those three corrections~~ — **done: verdict PASS** (§18). All three
   findings confirmed resolved; 153/153 tests, TypeScript and `git diff --check` all passing; the
   zero-AI / zero-browser / zero-database boundary confirmed; Part 1 declared safe to commit.
6. ~~Exact-file commit~~ — **done**: `3cedf83`, operator-approved 2026-07-17, after the PASS.
7. ~~Push~~ — **done** 2026-07-17: `c69866a..e208cbd`, fast-forward. `origin/main` = `e208cbd` and holds
   both `3cedf83` and `e208cbd`; local `main` verified level with `origin/main`.
8. ~~Freeze the part 1 safeguards on the do-not-repeat list~~ — **done** (§14): PASS + committed + pushed.
9. **Bundle-backed live-ingestion integration (part 2)** — the task named above. **Awaits its own
   explicit instruction.**

### 0.4b Do-not-repeat

The complete list is **§14**. Read it before proposing any work. Nothing on it may be reopened without a
specific, demonstrated regression.

### 0.5 All files in Phase 1 part 1 — committed as `3cedf83`, pushed to `origin/main`

Ten files, staged by exact name. `docs/PROJECT_STATUS.md` is deliberately **not** in `3cedf83`: it is
committed separately (`e208cbd`, and this finalisation) so it can record the real hashes.

| File | State |
|---|---|
| `lib/analysis/browserAnalysisBundle.ts` | **new** — schema v2, validator (incl. standalone source-row binding), temp-file atomic writer, sidecar loader |
| `lib/analysis/creativeAssetFiles.ts` | **new** — pure creative-file allowlist |
| `lib/analysis/sourceRowIdentity.ts` | **new** — pure canonical CSV-row identity |
| `lib/analysis/bundleAssembly.ts` | **new** (final correction) — pure bundle-row assembly + held-only output decision |
| `scripts/validate-browser-analysis-bundle.ts` | **new** — validator CLI |
| `scripts/plan-browser-ingest-from-bundle.ts` | **new** — bundle-only no-write planner |
| `tests/browser-analysis-bundle.test.ts` | **new** — 153 tracked tests |
| `scripts/preview-browser-collected-ads.ts` | modified — opt-in bundle output, honest scope, held-only scopes |
| `lib/analysis/creativeAssetAnalyser.ts` | modified — imports/re-exports the pure allowlist only |
| `package.json` | modified — `test:browser-bundle`, `browser:bundle:validate`, `browser:plan-from-bundle` |
| `docs/PROJECT_STATUS.md` | modified — this tracker; **separate commit**, not part of `3cedf83` |

**Untouched by design:** `scripts/ingest-browser-collected-ads.ts` (the live path), `prisma/schema.prisma`,
all UI. **Never touched:** `AGENTS.md`, `.claude/settings.local.json`, `dir`, `findstr`, `git`,
`scripts/_orig_check.ts`, and all generated CSVs/logs/reports/assets/databases/backups.

### 0.6 Checks already performed — do not redo blindly

| Check | Result |
|---|---|
| `npm run test:browser-bundle` | **153 tests, 153 pass, 0 fail, 0 skipped** (87 → 139 → 153 across the two correction rounds) |
| `npx tsc --noEmit --incremental false` | exit 0 |
| `git diff --check` | exit 0 |
| Validator CLI, full file checks | `VALID — STRUCTURE, SOURCE AND ASSET INTEGRITY VERIFIED` — **pre-correction only** (see note below) |
| Validator CLI, `--no-file-checks` | `STRUCTURALLY VALID — SOURCE AND ASSET INTEGRITY NOT VERIFIED` — **pre-correction only** |
| Validator CLI, bad args | unknown flag and two-paths both rejected |
| Planner CLI vs real 10-row Castlery CSV | 1 INSERT · 1 SKIP · 7 REVIEW · 1 UNAVAILABLE — **pre-correction only** |
| Full Castlery no-spend preflight | 10 input · 9 READY · 1 UNAVAILABLE · 9 analyses · 34 planned inputs · all videos 4-of-4 |
| Filtered no-spend preflight | 2 requested · 2 matched · 2 analyses · 8 planned inputs · `1442273137905726` excluded |
| Paid Vision run **in this task/session** | **none** — `ANTHROPIC_API_KEY` absent here, zero Anthropic calls during Phase 1 implementation and zero in this Claude Code session |
| Paid Vision runs **historically** | **Earlier bounded paid preview runs DID occur**, run separately by the operator from Windows Command Prompt. Their output was **terminal-only** and was never saved as a reusable analysis bundle. Do **not** state that no paid run has ever occurred. |
| Database | **never written or read** by any Phase 1 work; `prisma/dev.db` mtime unchanged all session |

> **CLI rows marked "pre-correction only" were run in the earlier session, against the code as it stood
> before the final Codex correction.** The correction session ran only the tracked test suite, `tsc` and
> `git diff --check`; no CLI was run against real project data. Those CLI results therefore describe the
> previous code and are **not** evidence about the corrected code. Re-running them needs explicit approval.

### 0.7 Decisions the next session MUST preserve

1. **A failed ad is never dropped.** It becomes an honest `ERROR` row. Counts derive from the row array —
   never reset a count (schema v1 did this and it was rejected in review).
2. **Discriminated rows.** `error_reason` is `null` **iff** SUCCESS; held rows carry a non-empty reason and
   **no result keys at all**. Per-variant key allowlists enforce this.
3. **The pure-module boundary is load-bearing.** `browserAnalysisBundle.ts`, `sourceRowIdentity.ts`,
   `creativeAssetFiles.ts` and the planner must **never** import `creativeAssetAnalyser`, Prisma,
   Playwright or the live-ingestion script. A tracked test asserts this — keep it passing.
4. **No recompute fallback, ever.** Missing bundle → fail. Invalid/stale → fail. Missing row → REVIEW.
   Never "fall back to calling Vision".
5. **The planner is a separate no-write path.** The live `ingest-browser-collected-ads.ts` was left
   unchanged deliberately; the next task changes it under its own approval.
6. **`UPDATE` comes from an injected id set** (`BROWSER_PLAN_EXISTING_AD_IDS`), not a DB read, so the
   planner stays DB-free. A later phase swaps in a real lookup.
7. **Visual confidence is VIDEO-only and fails closed to LOW.** It is **not** benchmark confidence and must
   never be mapped into it.
8. **The analysis cap counts logical analyses (requests), not files.**
9. **Behavioural triggers affect output only** — not any numeric score. Verified.
10. **Bundle scope honesty:** without a filter, scope = every source row; with one, scope = exactly the
    requested IDs (any status); a requested ID absent from source **fails** the output.
11. **No new paid Vision runs** until Phase 1 completes (§10) — preflights are free, use them. Note this
    is a *forward* policy: earlier bounded paid previews **did** already happen from Command Prompt
    (terminal-only, no bundle saved). Never claim no paid run has ever occurred.
12. **The active phase changes only when §11 completion criteria are met**, or when the user explicitly
    reprioritises (§20). Finding a quality bug does **not** reopen frozen work (§14).
13. **Generated artefacts stay outside the repo** (session scratchpad). `tests/` holds source only.
14. Honest reporting: the validator is *defensive*, not a proof that prose contains no secret. Do not
    overstate it.
15. **Bundle content never streams into the final path.** Writes go to a same-directory temp file, which
    is fully written, flushed and closed before the destination is created; no-overwrite finalises with
    `link()` (atomic, EEXIST-on-conflict, no check-then-write race) and confirmed overwrite with
    `rename()`. Where a filesystem cannot provide the no-clobber operation, nothing is written and the
    call fails — do **not** add a weaker interruptible fallback, and do not claim atomicity the code
    does not provide.
15a. **Temp cleanup is best-effort and says so.** Removal is attempted on every exit, but an unlink
    failure is reported (`warnings` on success, an appended note on failure) and never presented as a
    confirmed removal. A cleanup failure never invalidates an already-correct final file, and never
    replaces the original operational failure.
15b. **Final verification fails closed.** After finalisation the file is re-read, its checksum compared
    to the serialised bundle, and its byte size checked against the bytes written. If any of that cannot
    be done, the call FAILS rather than reporting a fabricated size — `bytes: 0` is never a verdict. The
    finalised file is left alone: the honest report is "exists but unverified", never "not written".
15c. **An ASSET SUCCESS row must declare a non-empty `creative_asset_path`.** Structural rule, enforced
    before any disk check, so a fabricated manifest can never skip file/checksum/size validation by
    declaring no path. The empty-path skip inside disk validation applies only to rows that consumed
    nothing.
16. **A held-only scope is an honest result, not an error.** With an output file requested and no READY
    rows, preview records every scoped row (REVIEW / SKIPPED, `source_status` preserved) and calls no
    model. The preflight still writes nothing, and no output file still early-returns.
17. **Source rows are never silently filtered.** A blank, whitespace-only, malformed or duplicate `ad_id`
    — or a missing `ad_id` column — fails the whole plan/bundle. Offending values are never echoed into
    an error message.

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
| Latest stable commit | `e208cbd` — `docs: record final Phase 1 part 1 review`. **`main` and `origin/main` are level.** |
| Latest implementation commit | `3cedf83` — `feat: add reusable browser-analysis bundle handoff (Phase 1 part 1)`, reviewed (Codex PASS), pushed |
| Application | Local-first Next.js 14 (App Router) |
| Database | Prisma ORM over SQLite (`prisma/dev.db`, local) |
| Collection policy | Browser-first canonical; Meta API diagnostic only |
| Canonical workflow ends at | **Terminal preview output only** — nothing is persisted |
| Ingestion path | **Separate**, and currently **repeats Vision analysis** rather than consuming the completed preview |

Working tree: `main` is **level with `origin/main`** at `e208cbd`; `3cedf83` (Phase 1 part 1) is pushed
and present on the remote. Tracked files are clean; the known protected untracked files remain present
and untouched (`AGENTS.md`, `dir`, `findstr`, `git`, `scripts/_orig_check.ts`).

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
- **Preview does not surface two bundle-writer diagnostics — LOW severity, reviewed and ACCEPTED as
  deferred** (raised while correcting the re-review findings; preview was out of scope for that session,
  and the final Codex re-review passed with both recorded here):
  1. `writeBundleAtomic()` returns `warnings` when temp-file cleanup could not be confirmed. Preview
     ignores that field, so a stray temp file is reported to nobody.
  2. When finalisation succeeds but final verification fails, the writer returns a failure whose text
     states plainly that the file EXISTS but is unverified. Preview's headline for any write failure is
     `Bundle NOT written`, which is wrong in that one case — **the detail lines beneath it are accurate
     and the exit status is still non-zero.**
  Both are display-only: no incorrect bundle is produced, nothing unsafe is written, and neither can
  cause a bad bundle to be consumed.
- **Tracked automated tests exist only for the Phase 1 bundle handoff.** `tests/browser-analysis-bundle.test.ts`
  runs 153 tests via `npm run test:browser-bundle` (committed in `3cedf83`). Everything outside that
  handoff — discovery, capture, the video parser, scoring, ingestion, the UI — still has **no** tracked
  test. The `6564b41` parser/trigger assertions remain synthetic and untracked (§18).

> **Individual Vision-description quality tuning is deferred until the complete local v1
> architecture is functional. Do not resume paid Vision testing during the current build phase.**
> Paid runs before analysis reuse (Phase 1) and review persistence (Phase 2) exist would re-spend on
> every iteration and cannot be captured or reviewed.

---

## 11. Remaining build phases

Shortest non-duplicative sequence to complete local v1. Phases already complete are not listed.

### Phase 1 — Reusable analysis handoff  ← **ACTIVE and PARTIAL** (part 1 done, reviewed, pushed, frozen; part 2 not started)

- **Objective:** make a completed preview a durable, validated ingestion input.
- **Delivered in `3cedf83` — corrected after the first independent review and again after both the final
  Codex review's and the focused re-review's NEEDS CHANGES verdicts, then PASSED by the final minimal
  Codex re-review before commit (§18):**
  - `lib/analysis/bundleAssembly.ts` — **pure** bundle-row assembly shared by preview and its tests, plus
    the held-only output decision rule. Makes the honesty contract provable without running preview.
  - `lib/analysis/creativeAssetFiles.ts` — **pure** creative-file allowlist. The analyser now imports it,
    so the validator/planner share the identical rule **without** importing the Anthropic analyser.
  - `lib/analysis/sourceRowIdentity.ts` — **pure** canonical CSV-row identity (ad id, row number, status,
    media type, canonical repo-relative asset path, scoring copy) used by **both** the writer and the planner.
  - `lib/analysis/browserAnalysisBundle.ts` — bundle **schema v2**: discriminated row union
    (SUCCESS | REVIEW | SKIPPED | ERROR), SHA-256 source/sidecar/asset integrity with `realpath`
    containment (enforced for **every** declared path, manifest or not) and byte-size checks, canonical
    enum + 0–10 range validation, exact ISO instants, targeted sensitive-content guards (including on
    `analysis_model`), VIDEO manifest cardinality against `ai_video_max_frames`, **standalone source-row
    binding** (row count, selected-ID presence, field-by-field identity), a required non-empty
    `creative_asset_path` for ASSET SUCCESS rows so no manifest can skip disk validation, stable-order
    serialiser, temp-file writer with atomic no-clobber finalisation, best-effort-but-reported temp
    cleanup and fail-closed final checksum/byte-size verification, provenance-aware verified-metadata
    sidecar loader.
  - `scripts/validate-browser-analysis-bundle.ts` — `npm run browser:bundle:validate`; strict args;
    prints **VALID — STRUCTURE, SOURCE AND ASSET INTEGRITY VERIFIED** or, with `--no-file-checks`,
    **STRUCTURALLY VALID — SOURCE AND ASSET INTEGRITY NOT VERIFIED**.
  - `scripts/plan-browser-ingest-from-bundle.ts` — `npm run browser:plan-from-bundle`; bundle-only,
    no-write planner; per-row source binding; exact include/exclude; ACCEPT-only verified metadata.
  - `scripts/preview-browser-collected-ads.ts` — opt-in `AI_PREVIEW_OUTPUT_FILE`; **honest scope** (every
    scope ad gets exactly one row; a failed analysis becomes an ERROR row and is never dropped); counts
    derived from rows; a requested bundle is produced for **held-only scopes** (no READY rows) with no
    Anthropic call; requested-output failure **exits non-zero**.
  - `tests/browser-analysis-bundle.test.ts` — **153 tracked tests** via `npm run test:browser-bundle`
    (Node's built-in `node:test` through tsx — no new framework).
- **Work remaining before Phase 1 is complete:**
  1. **The real `browser:ingest` is still not bundle-backed.** It still calls `resolveCreativeContext()`
     (line 695) **before** the duplicate check (line 756), so live browser ingestion can still be charged
     twice. The planner is a separate safe path; the charging path is unchanged by design.
  2. **No bundle produced by a real paid preview exists yet.** Earlier bounded paid previews did run
     (from Command Prompt) but were terminal-only and predate the bundle writer, so none saved a bundle.
     Every bundle exercised so far is synthetic or built from real assets with placeholder analysis text.
- **Dependencies:** existing planner/parser and exact-ID filter (both complete).
- **Completion criteria:** preview can explicitly save a validated result ✅; a matching valid bundle causes
  **zero** Anthropic calls ✅ (planner, proven by tracked import-boundary test); stale/mismatched bundles and
  row-level drift fail closed ✅; exact selected ad IDs recorded ✅; deterministic scores and visual
  confidence preserved ✅; **the real ingestion path consumes the bundle ❌ (outstanding)**.
- **Validation:** `npm run test:browser-bundle` (153 passing), `npx tsc --noEmit --incremental false`,
  `git diff --check`. The no-spend preflights were last exercised before the final correction (§0.6).
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

> ### ACTIVE: **Phase 1 — Reusable analysis handoff** · **part 1 DONE (frozen), part 2 NOT STARTED**

**Phase 1 is ACTIVE and partial.** Part 1 — the bundle, validator, planner and 153 tracked tests — is
reviewed (Codex PASS), committed (`3cedf83`), pushed and frozen (§14). Phase 1 is **not** complete, for
three reasons that all belong to part 2:

1. `scripts/ingest-browser-collected-ads.ts` is **not bundle-backed**;
2. live ingestion still calls `resolveCreativeContext()` (line 695) **before** the duplicate check
   (line 756), so it **can still repeat paid AI analysis**, dry runs included;
3. **no reusable bundle from a real paid preview exists** — every bundle so far is synthetic or carries
   placeholder analysis text.

Browser collection and Vision prompt quality are **frozen** unless a concrete regression blocks
implementation.

- **Goal:** a versioned, checksum-validated browser-analysis bundle that ingestion consumes with
  zero Anthropic calls.
- **Files likely involved (part 2):** `scripts/ingest-browser-collected-ads.ts` — the part 1 modules
  (`lib/analysis/browserAnalysisBundle.ts`, `sourceRowIdentity.ts`) are complete and are **reused, not
  rewritten**.
- **Boundaries:** no Prisma/schema change yet; no DB writes; no paid calls; no browser runs; no
  capture or prompt changes.
- **Validation:** `npx tsc --noEmit`; `git diff --check`; no-spend preflights unchanged; tracked unit
  tests for the bundle schema/validator.
- **Expected output:** a saved bundle file plus a bundle-backed ingestion **planning** path that
  provably makes no external call.

---

## 13. Next exact task

> **This IS the next exact task (Phase 1 part 2), and it has NOT been instructed yet.** Part 1 — the
> bundle (schema v2), strict validator, bundle-backed planner and 153 tracked tests — passed its final
> Codex re-review, is committed as `3cedf83`, pushed, and frozen (§14). The spec below is the agreed
> next task, **not a licence to start**: it requires a separate explicit task instruction. §0.4 records
> the required boundary.
>
> **Integrate the validated bundle into the real ingestion path without another AI call.**
> Make `scripts/ingest-browser-collected-ads.ts` consume a validated bundle instead of calling
> `resolveCreativeContext()` (line 695), so a Vision charge can never precede the line-756 duplicate
> check — and so dry-run ingestion costs nothing. Reuse `loadBundle()`, `bundleRowIdentity()` and
> `sourceRowIdentityMismatch()`; fail closed on a missing/invalid/stale bundle with **no** recompute
> fallback. Keep the triple-flag live-write guard, READY-only eligibility and verified-ACCEPT-only
> metadata. No Prisma/schema change. Add tracked tests for the new ingestion path.
>
> The original Phase 1 scope below is retained for reference.

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

**Phase 1 part 1 — the reusable analysis handoff. FROZEN on 2026-07-17**, having met this section's full
condition: Codex **PASS** ✅ · committed (`3cedf83`) ✅ · pushed to `origin/main` ✅ · 153 tracked tests
passing ✅. Do not redesign, rebuild or re-litigate any of it without a specific, demonstrated regression:

- Reusable browser-analysis bundle **schema v2**.
- The **discriminated SUCCESS / REVIEW / SKIPPED / ERROR** row structure, and the rule that held rows
  carry a reason and no result fields at all.
- **Honest failed-row and selected-ID accounting** — every scoped ad gets exactly one row, a failed
  analysis survives as an ERROR row, and counts derive from the rows and are never reset.
- **Strict source-CSV, verified-sidecar, asset and per-row source-identity validation**, including the
  standalone source-row binding in full disk validation.
- **Asset hash, byte-size, realpath containment and VIDEO frame-limit checks**, and the required
  non-empty `creative_asset_path` on ASSET SUCCESS rows.
- The **pure creative-file allowlist and source-row identity helpers** (`creativeAssetFiles.ts`,
  `sourceRowIdentity.ts`, `bundleAssembly.ts`).
- The **structural zero-AI, zero-browser, zero-database planner/validator boundary** and its tracked
  import-boundary test.
- The **bundle-backed no-write ingestion planner**, the opt-in preview bundle output and held-only
  bundle output.
- The **atomic same-directory temp-file bundle writer** with no-clobber `link()` finalisation, its
  documented narrowed guarantee where a filesystem cannot provide it, best-effort-but-reported cleanup,
  and fail-closed final checksum/byte-size verification.
- The **tracked browser-bundle test suite** — `npm run test:browser-bundle`, currently **153 passing**.

**Not frozen — two accepted low-severity DEFERRED presentation items** (§10). These are display issues
in preview only. They are **not** a reason to reopen any frozen architecture above:

1. Preview does not display the writer's `warnings`, so an unconfirmed temp-file cleanup is not surfaced.
2. Preview prints `Bundle NOT written` for an existing-but-unverified file — **the detail lines are
   accurate and the exit status is still non-zero.**

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
| `3cedf83` | Phase 1 | `npm run test:browser-bundle` — bundle schema, validator, source binding, planner, atomic write + cleanup/verification reporting, held-only assembly | **PASS — 153 tests, 0 fail, 0 skipped** | **Repo-verifiable** — the suite is tracked at `3cedf83`. 87 → 139 → 153 across the two correction rounds |
| `3cedf83` | Phase 1 | `npx tsc --noEmit --incremental false`; `git diff --check` | PASS (exit 0) | **Repo-verifiable** — run on the exact tree that was committed |
| 2026-07-17, at the tree committed as `3cedf83` | Phase 1 part 1 | **Final minimal independent Codex read-only re-review** of the three focused-re-review corrections: ASSET empty-path bypass, temp-cleanup reporting, final checksum/byte-size verification | **PASS** | **Operator-reported** (Codex runs outside this repo, so the verdict itself is not repo-verifiable — the tree it reviewed is). Confirmed: 153 tests passed, 0 failed, 0 skipped; TypeScript passed; `git diff --check` passed; ASSET empty-path bypass resolved; temp cleanup correctly treated as best-effort; final checksum and byte-size verification fails closed; zero-AI / zero-browser / zero-database boundary passed. **Phase 1 part 1 declared safe to commit** — the commit followed this verdict |
| — | Tests | Automated tests outside the Phase 1 bundle handoff | **Missing** | Discovery, capture, parser, scoring, ingestion and UI have no tracked spec files |

---

## 19. Append-only change log

**Append new rows at the bottom. Never rewrite history.**

| Date | Commit | What changed | What became complete | What remains |
|---|---|---|---|---|
| 2026-07-16 | `6564b41` | Baseline recorded. Multi-frame video hardening: labelled frame blocks, strict four-section parsing, exact frame-observation validation, neutral malformed fallback, visual confidence display. | Strict VIDEO response parsing; visual-confidence **display**; frame-observation validation | Analysis bundle + reuse (Phase 1); browser review/exceptions (Phase 2); browser `ScanRun` (Phase 3); operational UI (Phase 4); resume + scheduling (Phase 5) |
| 2026-07-16 | (uncommitted) | Created `docs/PROJECT_STATUS.md` as the canonical tracker from the independent Codex audit. | Single source of truth for status, phases, do-not-repeat and agent roles | Phase 1 implementation |
| 2026-07-16 | `c69866a` | Tracker committed and pushed. | Canonical tracker published | Phase 1 implementation |
| 2026-07-16 | (uncommitted) | **[HISTORICAL — SUPERSEDED, see the schema-v2 row below. This row describes the schema-v1 attempt as it stood on 2026-07-16; it is NOT the current implementation. Schema v1 was rejected in review because its writer silently dropped failed ads and zeroed the failed count. No v1 code survives.]** **Phase 1 part 1.** Added `lib/analysis/browserAnalysisBundle.ts` (schema v1, checksums, strict validator, atomic writer); `scripts/validate-browser-analysis-bundle.ts`; `scripts/plan-browser-ingest-from-bundle.ts`; opt-in `AI_PREVIEW_OUTPUT_FILE` in preview; 2 npm scripts. | Versioned bundle + strict validator + **bundle-only, zero-AI, no-write planner**; overwrite protection; exact include/exclude | **Tracked** unit tests; make the real `browser:ingest` bundle-backed (it still calls Anthropic at line 695 before dedup at 756); produce a real bundle from a paid preview |
| 2026-07-16 | (uncommitted) | **Session handover** written (§0): complete/in-progress/blocked, next exact task, all files changed, all checks performed, do-not-repeat pointer, and decisions the next session must preserve. | Session-resumable handover | — |
| 2026-07-16 | (uncommitted) | **Handover factual correction.** (a) Paid-Vision history restated: no paid call in this task/session, but **earlier bounded paid previews did occur** from Command Prompt (terminal-only, no bundle saved) — the "never performed" claim was wrong. (b) Phase 1 part 1 blocker restated: awaiting **final independent Codex review**, not merely commit approval; not safe to stage until the verdict returns. (c) Immediate next task set to the **Codex review**, with the sequence review → fix findings → commit/push → then live-ingestion integration. (d) The unreviewed bundle schema / validator / pure-module boundary **removed from the frozen do-not-repeat list** and recorded as **provisional**. | Accurate handover; unreviewed work no longer presented as frozen | Codex review verdict |
| 2026-07-16 | (uncommitted) | **Phase 1 part 1 correction** after independent review. Bundle **schema v2**: discriminated row union so failed ads survive as honest ERROR rows (the v1 writer silently dropped them and zeroed the failed count); per-row source binding via new pure `sourceRowIdentity.ts`; pure `creativeAssetFiles.ts` allowlist removes the analyser import from the validator/planner path; realpath containment + byte-size + range/enum/ISO validation; targeted sensitive-content guards; exclusive-create atomic write reporting the re-read final file; non-zero exit on requested-output failure; strict validator arg parsing and honest `--no-file-checks` wording; ACCEPT-only verified metadata in the plan; **87 tracked tests** (`npm run test:browser-bundle`). | Honest complete row accounting; row-level drift detection; structural zero-AI/browser/DB boundary proven by a tracked test | Make the real `browser:ingest` bundle-backed (still charges AI at line 695 before dedup at 756); produce a real bundle from an approved paid preview |
| 2026-07-17 | (uncommitted) | **Phase 1 part 1 — final Codex correction.** The final independent review returned **NEEDS CHANGES**; all six findings corrected. (1) **Atomic write:** every write now goes through a same-directory temp file that is fully written, `fsync`ed and closed before the destination exists; no-overwrite finalises with `link()` (atomic, fails EEXIST, no check-then-write race) and fails safely with a documented narrowed guarantee where the filesystem cannot support it; confirmed overwrite finalises with `rename()` from the completed temp file; temp files are cleaned on success and failure. The old path opened the FINAL file with `wx` and streamed into it, so an interrupted write could leave a misleading final bundle. (2) **`analysis_model`** now gets bounded-length (80) and sensitive-content scanning; the rejected value is never echoed. (3) **Planner** no longer silently filters blank `ad_id` rows: new pure `parseSourceIdentities()` rejects a missing `ad_id` column, and blank / whitespace-only / malformed / duplicate ids fail the WHOLE plan without echoing the value. (4) **Held-only scopes** with an output file requested now produce an honest bundle instead of returning early (NEEDS_REVIEW→REVIEW, SKIP→SKIPPED, UNAVAILABLE→SKIPPED retaining `source_status`); the preflight still writes nothing and no output file still early-returns. Row assembly extracted to the new pure `lib/analysis/bundleAssembly.ts`. (5) **VIDEO manifest cardinality** enforced against `ai_video_max_frames` (VIDEO only). (6) **`creative_asset_path` containment** now enforced for every declared path even with an empty manifest; existence is still only required where the row claims the asset was consumed. (7) **Standalone validation** now parses the declared source CSV with the same canonical identity rules and proves row count, selected/excluded ID presence, and field-by-field row binding; `--no-file-checks` stays structural-only. Tests: **87 → 139**, all passing. | Interruption-safe bundle output; no unscanned model string; no silently dropped source row; honest held-only bundles; validator independently proves the bundle-to-source relationship | **Final Codex re-review of these corrections** (immediate next task); then approved exact-file commit/push; then make the real `browser:ingest` bundle-backed (it still charges AI at line 695 before dedup at 756); produce a real bundle from an approved paid preview |
| 2026-07-17 | (uncommitted) | **Phase 1 part 1 — focused Codex re-review correction.** The re-review of the previous row's work returned **NEEDS CHANGES** for three narrower defects, all now closed in `lib/analysis/browserAnalysisBundle.ts`. (1) **Empty-path ASSET bypass:** a SUCCESS row with `creative_source: ASSET` and a non-empty manifest could declare `creative_asset_path: ""`, which passed shape validation and then hit the empty-path skip in disk validation — so no file, checksum or byte-size check ran on a fabricated manifest. An ASSET SUCCESS row must now declare a non-empty (post-trim) path; the rule is structural, fires with `--no-file-checks`, and short-circuits before disk validation, so the skip can only apply to rows that consumed nothing. MANUAL/FALLBACK/REVIEW/SKIPPED/ERROR rules unchanged. (2) **Cleanup honesty:** temp-file unlink failures were swallowed while the docstring claimed removal was unconditional. Removal is still attempted on every exit, but is now documented and reported as best-effort: an unconfirmed cleanup surfaces as `warnings` on success and as an appended note on failure, never replacing the original failure, and never invalidating an already-correct final file. (3) **Final verification fails closed:** a `stat` failure previously returned `ok: true` with `bytes: 0`. The final file is now re-read, its checksum compared against the serialised bundle and its size compared against the bytes written; any gap returns a failure stating the file EXISTS but is UNVERIFIED, without deleting or rewriting it. A narrow `__testHooks` seam (unlink / statSize / hashFile) makes all three provable. Tests: **139 → 153**, all passing. Two display-only gaps recorded in §10 (preview does not print `warnings`, and labels the exists-but-unverified case `Bundle NOT written`). | Fabricated manifests can no longer skip asset verification; cleanup and byte-size reporting no longer claim more than the code proves | **One final minimal Codex re-review of these three corrections** (immediate next task); then approved exact-file commit/push; then make the real `browser:ingest` bundle-backed (still charges AI at line 695 before dedup at 756); produce a real bundle from an approved paid preview; fix the two §10 preview display gaps |
| 2026-07-17 | `3cedf83` | **Phase 1 part 1 reviewed and committed.** The **final minimal independent Codex re-review returned PASS** on the tree — all three focused findings confirmed resolved, 153 tests passed / 0 failed / 0 skipped, TypeScript passed, `git diff --check` passed, zero-AI / zero-browser / zero-database boundary passed — and declared Part 1 **safe to commit**. The operator then approved the commit. Ten files staged by exact name (the four protected untracked files and `scripts/_orig_check.ts` were not touched): the three pure modules (`browserAnalysisBundle.ts`, `sourceRowIdentity.ts`, `creativeAssetFiles.ts`), the pure `bundleAssembly.ts`, the validator and planner CLIs, the preview bundle output, the analyser's allowlist re-export, `package.json`'s three scripts, and the 153-test tracked suite. No code changed at commit time — this is exactly the reviewed and validated tree. **Not pushed** — push was not approved. | Phase 1 part 1 is independently reviewed, PASSED and version-controlled; commit-ready work is complete | **Push approval** (the only outstanding item); then the real `browser:ingest` bundle-backed integration (§13, still charges AI at line 695 before dedup at 756); a real bundle from an approved paid preview; the two low-severity §10 preview display items |
| 2026-07-17 | `65381a8` (amended) | **Tracker factual correction.** The tracker as first written at `65381a8` wrongly stated that the final minimal Codex re-review was still **outstanding** and that Part 1 had been committed **ahead of** independent verification. That was wrong on both counts: the re-review had already run **before** the commits and returned **PASS**. Corrected across every live-status section — §0 handover header, §0.1, §0.2, §0.3 blocked table, §0.4 next action, §11 Phase 1, §13, §14 provisional list, §18 validation log, and the `3cedf83` row above — so the tracker now records the PASS, states that **no further Codex review is required before push**, and names **push approval** as the immediate action. Phase 1 part 1 stays **provisional rather than frozen** for one reason only: §14 requires a Codex PASS *and* a **pushed** change, and the push has not happened. Historical rows above are unchanged: they were accurate when written. Phase 1 remains **ACTIVE and partial** — live ingestion is not bundle-backed, still repeats AI, and no bundle from a real paid preview exists. | An accurate record: review status, commit status and the immediate action are no longer contradicted by the tracker | Push approval |
| 2026-07-17 | (docs-only, this commit) | **Phase 1 part 1 push finalisation.** `3cedf83` (implementation) and `e208cbd` (the review record) were pushed to `origin/main` — `c69866a..e208cbd`, fast-forward, no force. Verified after the push: `origin/main` = `e208cbd`, both commits present in remote history by ancestry, local `main` level with `origin/main`, tracked files clean. Tracker finalised accordingly: every live-status section now states that Part 1 is reviewed, committed **and pushed**, with **nothing pending** — no review, no commit, no push. §14: the part 1 safeguards **moved from provisional to FROZEN**, the full condition now being met (Codex PASS ✅ · committed ✅ · pushed ✅ · 153 tests ✅) — bundle schema v2; discriminated SUCCESS/REVIEW/SKIPPED/ERROR rows; honest failed-row and selected-ID accounting; strict source/sidecar/asset/per-row-identity validation; asset hash, byte-size, containment and VIDEO frame-limit checks; the pure allowlist and identity helpers; the structural zero-AI/zero-browser/zero-database boundary; the no-write planner; the atomic temp-file writer with fail-closed final verification; and the 153-test tracked suite. The two low-severity preview **presentation** items stay deferred and explicitly outside the frozen-complete list (§10) — they are display-only and are not grounds to reopen part 1. §0.4/§13 set the next exact task: **integrate the validated bundle into the real browser-ingestion path so ingestion reuses approved analysis with no second Anthropic call**, bounded by — no second AI analysis; validate bundle and source identity before planning writes; deduplicate before any optional external work; preserve per-row REVIEW/ERROR isolation; no DB write as part of tracker work; and a **separate explicit instruction required** before that implementation begins. | Phase 1 part 1 is complete, verified on the remote, and frozen against rework | **Phase 1 remains ACTIVE and partial** (part 2 not started): `ingest-browser-collected-ads.ts` is not bundle-backed and still calls `resolveCreativeContext()` at line 695 before dedup at line 756, so it can repeat paid AI; and no bundle from a real paid preview exists yet |

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
