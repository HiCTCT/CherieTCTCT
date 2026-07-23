# Meta Ad Library Database — Project Status

**This document is the canonical source of truth for this project.**

It exists because work has been spread across multiple chats and coding agents, which caused
completed features, partial features, tests and deferred issues to be confused and repeated.
Every future chat and agent must read this document first and update it per section 20.

Primary evidence: independent read-only Codex audit at commit `6564b41`, cross-checked against
the tracked repository. Status is based on that evidence — **not** on the mere existence of code.

---

## 0. Session handover — READ FIRST

_Last updated: 2026-07-23. Part 1 is reviewed (**Codex PASS**), committed and **pushed**. **Part 2 —
bundle-backed live ingestion — is committed and pushed at `d060a69`; its review gate is closed.**
**Checkpoint 3B — the approved one-ad live ingestion — RAN EXACTLY ONCE on 2026-07-23 and inserted ad
`3831676167136939` (one `Ad` + one `AdAnalysis`, atomic). All Phase 1 operational checkpoints are now
COMPLETE.**
**PHASE 2 checkpoints 2.1 and 2.2 are COMPLETE, committed and pushed (`15584ec`, `27c7c0e`): the
source-neutral review-state contract, the `ReviewCandidate` Prisma model, the pure persistence/payload
contracts, and the additive migration — which was REHEARSED on a disposable copy and then APPLIED to
`prisma/dev.db` on 2026-07-23 (integrity ok; existing rows unchanged; `ReviewCandidate` empty).
Checkpoint 2.2 provides the SCHEMA and PURE CONTRACTS ONLY — live candidate creation, promotion wiring,
review UI and Meta-row migration are NOT yet implemented.**_

### 0.1 What is complete

- **Frozen and proven** (see §4, §14): Phase 0 discovery safety, capped `PARTIAL_DISCOVERY`, canonical
  empty active scope, footer provenance, raw headline/description exclusion, image/carousel/video-frame
  capture, UNAVAILABLE-vs-NEEDS_REVIEW classification, creative-file allowlist, no-spend preflight,
  paid confirmation + analysis cap, exact-ID preview filter, numeric multi-frame ordering, strict VIDEO
  parsing, visual-confidence **display**, deterministic trigger hardening.
- **Committed and pushed in earlier sessions:** `74789e7`, `3f3a76e`, `d379f81`, `b45778a`, `22c6c7a`,
  `6564b41`, `c69866a`.
- **Committed and pushed on 2026-07-17:** `3cedf83` (Phase 1 part 1 implementation), `e208cbd` (tracker
  recording the final Codex PASS) and `ed71513` (tracker finalisation).
- **Committed and pushed on 2026-07-17:** **`d060a69`** — `feat: add bundle-backed browser ingestion
  (Phase 1 part 2)`. **The latest committed baseline is `d060a69`**, which is where `origin/main` and
  local `main` both sit.
- **Phase 1 part 1 — reviewed, committed and pushed. COMPLETE and FROZEN (§14):** versioned bundle
  (schema **v2**), strict fail-closed validator, bundle-backed **no-write planner**, opt-in preview
  bundle output, and **153 tracked tests passing**. Three review rounds ran in all: the first review,
  then the final review (**NEEDS CHANGES**, six findings), then the focused re-review (**NEEDS CHANGES**,
  three narrower findings — an empty-`creative_asset_path` ASSET bypass and two atomic-write reporting
  qualifications). Every finding was corrected, and the **final minimal Codex re-review returned PASS**
  before the commit (§18). **Nothing is pending for Part 1: no further review, no further commit, no
  further push.** Details in §11 Phase 1. Its safeguards are now on the frozen do-not-repeat list (§14)
  and must not be reopened without a specific, demonstrated regression.
- **Committed and pushed on 2026-07-23 — PHASE 2 checkpoint 2.1:** **`15584ec`** — `feat: add
  source-neutral review state contract`. Pure `lib/analysis/reviewState.ts`: decisions **ACCEPT and
  EXCLUDE only** (NOTE stays metadata, never a decision); states **PENDING / HELD / ACCEPTED /
  EXCLUDED**; exception categories **terminal** (`UNAVAILABLE`), **resolution-required**
  (`COMPETITOR_CONFLICT`, `MISSING_ANALYSIS`) and **review-overridable** (`NEEDS_REVIEW`,
  `LOW_VISUAL_CONFIDENCE`, `ASSET_COPY_MISMATCH`).
- **Committed and pushed on 2026-07-23 — PHASE 2 checkpoint 2.2:** **`27c7c0e`** — `feat: add
  ReviewCandidate model and review contract`. Additive `ReviewCandidate` Prisma model; pure
  `lib/analysis/reviewCandidatePersistence.ts` (canonical **hashed Meta identity**
  `meta:ad:sha256:<hash>`, advertiser-scoped fallback identity, one schema-versioned
  `PromotionPayloadV1` envelope, strict per-field verified-metadata copy gates, strict Phase-1-faithful
  AdAnalysis completeness validation); additive migration
  `prisma/migrations/20260723000000_add_review_candidate/migration.sql`. Independent Codex review
  (**operator-reported**): 1 BLOCKER + 2 MATERIAL findings, all corrected in one consolidated pass;
  confirmation returned **PASS**. **422 tracked tests** (38 + 60 + 153 + 171). **The migration was
  rehearsed on a disposable database copy, then applied to `prisma/dev.db` on 2026-07-23** — see §18.
  **Schema and pure contracts only: no live candidate creation, no promotion wiring, no review UI, no
  Meta-row migration exists yet.**

### 0.2 What is currently being worked on

**Phase 1 part 2 — bundle-backed live ingestion. COMMITTED and PUSHED as `d060a69`.** **Five Codex reviews completed, each NEEDS CHANGES, each closed by a focused correction pass. The production implementation and tests passed the substantive reviews; the final documentation correction was verified by the coordinator, and **the Part 2 review gate is CLOSED under the lean workflow**. Honest caveat: **no formal Codex PASS was ever issued for Part 2** — the last two rounds accepted the production code and tests without recording one. Part 2 is committed and pushed at `d060a69`.**

Codex confirmed sound and unchanged: zero-AI/zero-browser/zero-recomputation ingestion, v2 persistence
refusal, v3 preview serialisation, the pure mapping, duplicate skip-only handling, no update path, the
Ad + AdAnalysis transaction boundary, all three live-write flags, **zero-database dry-run (judged safer
and accepted — it is not a defect and must not be "fixed" to report duplicates)**, per-row isolation and
the recommendation-key rename.

**Five Codex reviews so far, all NEEDS CHANGES, all corrected. The canonical sequence:**

1. Part 2 implemented (schema v3 + bundle-backed ingestion).
2. **Codex review 1 → NEEDS CHANGES**: nine findings (sidecar binding, placeholder arrays, rubric,
   summary cross-check, benchmark semantics, `benchmarkScoredAt`, schema-aware drift, lazy Prisma,
   `Ad.adLink`).
3. Correction pass 1 — all nine closed.
4. **Codex review 2 → NEEDS CHANGES**: one material blocker — the benchmark validator accepted
   combinations the real scorer could never emit (**score 6.4 with tier MODERATE**, when MODERATE starts
   at 6.5, so 6.4 is WEAK). Range-checking each field was never enough; the *combination* had to be
   verified.
5. Correction pass 2 — the benchmark semantic contract.
6. **Codex review 3 → NEEDS CHANGES**: no production defect left; two accuracy problems — an overstated
   scorer/validator parity test, and contradictory tracker statements.
7. Correction pass 3 — a genuine parity test that invokes the production scorer, plus tracker fixes.
8. **Codex review 4 → NEEDS CHANGES**: still no production defect; the 6.4 negative regression was
   ambiguous (it overrode the score on a row whose breakdown computed 6.1, so it could fail for the
   wrong reason), and live tracker sections still contradicted each other.
9. **Correction pass 4** — the 6.4 regression isolated from a genuine production-scored row, and stale
   live tracker sections reconciled.
10. **Codex review 5 → NEEDS CHANGES — tracker accuracy only.** The **production implementation and
    tests were ACCEPTED**; three stale current-state tracker sections remained.
11. **Correction pass 5** — the stable baseline, executive workflow and validation history reconciled.
12. **Coordinator verification COMPLETE**, and Part 2 committed and pushed as `d060a69`. The review
    gate is closed under the lean workflow. **No formal Codex PASS was issued for Part 2**, and no
    further Codex review is outstanding.

Summary of the whole part:

- **The mapping audit gate FAILED first, and that drove the design.** Schema v2 records an analysis
  *summary*; the `AdAnalysis` model requires seven non-null fields v2 cannot supply truthfully —
  `creativeAnalysis`, `copyAnalysis`, `headlineAnalysis`, `descriptionAnalysis`, `weaknessesJson`,
  `improvementsJson`, `rubricScoresJson`. Filling them would have meant inventing content, re-running
  the scorer, or writing `''`/`[]`/`{}` — and `weaknessesJson: '[]'` would *assert* "no weaknesses
  found", which is false. Implementation stopped and the operator approved the additive fix below.
- **Approved decision, now implemented: schema v3.** v2 stays **frozen and immutable**; v3 is its
  additive successor, carrying the complete already-computed `AnalysisOutput` and `CompetitorBenchmark`
  (`analysis_result` / `benchmark_result`) that preview already held in memory.
- **v2 remains loadable, validatable and usable for no-write planning — and can NEVER authorise an
  INSERT.** A would-be writable v2 row routes to `BLOCKED_SCHEMA` with a precise reason. Only a fully
  validated **v3 SUCCESS** row (non-LOW confidence) is a persistence candidate.
- **`scripts/ingest-browser-collected-ads.ts` is now bundle-backed.** Every route to
  `resolveCreativeContext`, `analyseAdRow`, `scoreCompetitorBenchmarkAd`, the analyser, Anthropic,
  fetch and Playwright is **removed**. No recompute fallback exists. `ANTHROPIC_API_KEY` is neither
  required nor read.
- **The repeated-charge defect is closed.** There is no optional external work left in ingestion at all,
  so nothing can be charged before duplicate detection.
- **324 tracked tests pass** (153 Part 1, unchanged + 171 Part 2), `tsc` exit 0, `git diff --check` exit 0.
- **Schema v2 stays planning-only and can never persist; schema v3 is required for any INSERT.**
- **Scorer/validator parity is proven by execution:** a tracked test calls the production
  `scoreCompetitorBenchmarkAd()` for **ASSET, MANUAL and FALLBACK**, feeds each real return value
  through the schema-v3 validator, and asserts it is accepted — plus a mutation of a scorer-produced
  value is rejected. That is the extent of the claim: it covers the benchmark block, not end-to-end
  preview→ingest integration.
- **No paid preview, no Anthropic call, no browser run, and no real database access** occurred: the
  database boundary is an injected lazy factory, and every test uses a fake that counts client
  construction as well as calls.

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

**Phase 1's production code and all operational checkpoints are COMPLETE (§11, §12).** Part 1 is pushed and
frozen; **part 2 is committed and pushed as `d060a69`.** **Five Codex reviews completed, each NEEDS CHANGES, each closed by a focused correction pass. The production implementation and tests passed the substantive reviews; the final documentation correction was verified by the coordinator, and **the Part 2 review gate is CLOSED under the lean workflow**. Honest caveat: **no formal Codex PASS was ever issued for Part 2** — the last two rounds accepted the production code and tests without recording one. Part 2 is committed and pushed at `d060a69`.** The operational sequence is now finished:

1. ~~Part 2 needs final coordinator verification, then commit and push approval.~~ **DONE** — verified,
   committed and pushed as `d060a69`; its safeguards are now frozen (§14).
2. ~~No reusable bundle from a real paid preview exists.~~ **DONE — checkpoint 1** produced the **first
   real schema-v3 bundle** (`3831676167136939`), **checkpoint 2** validated it offline (exit 0),
   **checkpoint 3A** passed a bundle-backed dry run with zero database access, and the **3B preflight**
   backup was taken and verified (§18).
3. ~~Live ingestion has never been run against the database — the only remaining item.~~ **DONE —
   checkpoint 3B, 2026-07-23.** The approved one-ad live ingestion ran **exactly once**: INSERTED 1,
   REVIEW 8, UNAVAILABLE 1, WRITE_ERROR 0; one atomic `Ad` + `AdAnalysis` insert for `3831676167136939`;
   post-run verification and backup/bundle checksum re-verification all passed (§18).

**Phase 1 part 2 is DONE, and operational checkpoints 1, 2, 3A, the 3B preflight and 3B itself are all
COMPLETE** (§18): the first real schema-v3 bundle exists, it validates offline, the bundle-backed dry run
produced a clean plan with zero database access, the database was backed up outside the repository, and
the approved one-ad live ingestion ran exactly once.

**Checkpoint 3B — the one-ad LIVE INGESTION of `3831676167136939` — was approved and RAN EXACTLY ONCE
on 2026-07-23 (§0.4, §18): INSERTED 1, REVIEW 8, UNAVAILABLE 1, WRITE_ERROR 0; one `Ad` + one
`AdAnalysis` inserted atomically; no existing record updated or deleted; no AI/analyser/scorer/browser/
external call. All Phase 1 operational checkpoints are complete. No further database action is
authorised without a new explicit approval.**

### 0.3 What is blocked

| Blocked item | Reason | Unblocks when |
|---|---|---|
| Paid Vision preview **from a Claude Code session** | **Still blocked, and expected to stay that way.** `ANTHROPIC_API_KEY` is **ABSENT** from the environment a Claude Code session inherits; the script reads `process.env` directly — no dotenv loader — so a `.env` file will not work. **This is the operating model, not a defect:** paid previews are operator-run from an explicitly authorised shell. | Not applicable — the operator runs paid previews from Command Prompt. Claude Code must never assume the key is available. |
| ~~A bundle produced by a real paid preview (a **v3** bundle)~~ | **DONE — checkpoint 1, 2026-07-17.** The operator ran an approved one-ad paid preview for `3831676167136939`, producing the first real schema-v3 bundle. Offline-validated at checkpoint 2 (exit 0). See §18 and §19. | Done. |
| ~~Live browser DB ingestion (checkpoint 3B)~~ | **DONE — 2026-07-23.** Approved, executed **exactly once** for `3831676167136939`: INSERTED 1, REVIEW 8, UNAVAILABLE 1, WRITE_ERROR 0; one `Ad` + one `AdAnalysis` inserted atomically; post-run read-only verification and backup/bundle checksum re-verification all passed. See §18. | Done. |
| ~~Committing and pushing Phase 1 part 2~~ | **DONE — five Codex reviews (each NEEDS CHANGES, each closed by a correction pass), coordinator verification complete, committed and pushed as `d060a69` on 2026-07-17 (`ed71513..d060a69`, fast-forward).** | Done. |
| ~~Freezing the Part 2 safeguards on the do-not-repeat list (§14)~~ | **DONE — frozen under the lean workflow: coordinator verification + committed + pushed. See the §14 note on the absent formal Codex PASS.** | Done. |
| ~~Committing Phase 1 part 1~~ | **DONE — the final Codex re-review returned PASS, then the operator approved the commit. Committed as `3cedf83` on 2026-07-17.** | Done. |
| ~~Pushing `3cedf83` + `e208cbd` to `origin/main`~~ | **DONE — pushed 2026-07-17 (`c69866a..e208cbd`, fast-forward). `origin/main` contains both commits; local `main` verified level.** | Done. |
| ~~Freezing Phase 1 part 1 on the do-not-repeat list (§14)~~ | **DONE — §14 requires a Codex PASS **and** a committed, pushed change. PASS ✅, committed ✅, pushed ✅. Moved to the frozen list.** | Done. |

**Nothing in Phase 1 part 1 is blocked or pending.** The remaining blocked items above belong to Phase 1
part 2 and later phases.

### 0.4 The next exact task

> **None outstanding for Phase 1 operational work. Checkpoint 3B — the one-ad LIVE INGESTION of
> `3831676167136939` — was approved and completed on 2026-07-23. All Phase 1 operational checkpoints
> are COMPLETE.** No further database action is authorised without a new explicit approval.
>
> **PHASE 2 status:** checkpoints **2.1** (`15584ec`, review-state contract) and **2.2** (`27c7c0e`,
> `ReviewCandidate` model + pure persistence/payload contracts + additive migration) are **committed,
> pushed and complete**; the migration was **rehearsed on a disposable copy and applied to
> `prisma/dev.db` on 2026-07-23** (integrity ok, existing rows unchanged, `ReviewCandidate` empty — §18).
> **What exists is the schema and the pure contracts.** The next Phase 2 work — wiring live candidate
> creation, the atomic promotion transaction, the review queue/UI and any Meta-row migration — is **NOT
> implemented** and each step needs its own explicit approval.

**Phase 1 part 2 is DONE**: reviewed five times (NEEDS CHANGES each, each corrected), coordinator-verified,
validated (**324 tracked tests**, `tsc` exit 0, `git diff --check` exit 0), and **committed and pushed as
`d060a69`**. Its safeguards are frozen (§14). **No formal Codex PASS was issued** — the gate was closed by
coordinator verification under the lean workflow, and that is recorded honestly rather than as a PASS.

**All operational checkpoints — 1, 2, 3A, the 3B preflight, and 3B itself — are COMPLETE** (§18, §19): a
real schema-v3 bundle exists, it validates offline, the dry run produced a clean plan with zero database
access, the database was backed up outside the repository, and the **approved one-ad live ingestion ran
exactly once**.

> **Checkpoint 3B — one-ad live ingestion. DONE 2026-07-23.** The required shape, agreed in advance, was
> met exactly:
>
> - all three live-write flags set (`BROWSER_DRY_RUN=false`, `BROWSER_INGEST_WRITE=true`,
>   `BROWSER_INGEST_CONFIRM_DB_WRITES=I_UNDERSTAND`);
> - **exact duplicate read first** — dedup ran before any write;
> - the ad did not already exist, so **one atomic `Ad` + `AdAnalysis` insert** was made, and nothing else;
> - **post-run read-only database verification** confirmed adCount 1, analysisCount 1, `adSource`
>   `browser_collected`, `creativeSource` ASSET, `capturedAssetType` VIDEO_FRAME, headline null,
>   description null;
> - **backup and bundle checksum re-verification** afterwards both matched (see §18).
>
> Result: **INSERTED 1, REVIEW 8, UNAVAILABLE 1, WRITE_ERROR 0.** No existing record updated or deleted;
> no AI/analyser/scorer/browser/external call; no WAL/SHM/journal sidecar remained.

**The boundary part 2 was built to — a review should hold it to exactly this:**

- **No second AI analysis.** A validated bundle is the only source of analysis; there is **no recompute
  fallback** — missing bundle → fail, invalid or stale bundle → fail, missing row → REVIEW.
- **Validate the bundle and source identity BEFORE planning any write.** Full disk validation stays on
  (`checkFiles` is never disabled in the production path); whole-bundle failure ends the run before any
  planning.
- **Deduplicate before any optional external work.** There is now **no optional external work at all**,
  so nothing can be charged before dedup. This closed the old defect where `resolveCreativeContext()`
  at line 695 ran *before* the `prisma.ad.findMany` dedup at line 756.
- **Preserve per-row REVIEW/ERROR isolation** — one held or failed row never blocks another valid row.
- **Insert-only.** An existing ad is `SKIPPED_EXISTING`: no insert, no update, no analysis, no charge.
- Triple-flag live-write guard, READY-only eligibility and verified-ACCEPT-only metadata all unchanged.
  No Prisma/schema change. No UI change.

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
9. ~~Bundle-backed live-ingestion integration (part 2)~~ — **implemented 2026-07-17 after the mapping
   audit gate failed and the additive schema-v3 decision was approved.** Committed as `d060a69`.
10. ~~Independent Codex review of part 2.~~ **Done** — five reviews in total, all NEEDS CHANGES, all
    corrected; the gate was closed by coordinator verification under the lean workflow.
11. ~~Correct any findings → commit approval → push approval.~~ **Done** — `d060a69`, pushed.
12. **Operational checkpoints — 1, 2, 3A and the 3B preflight are COMPLETE** (§18): an approved paid
    preview produced the **first real schema-v3 bundle** for `3831676167136939` (checkpoint 1); it
    **passed offline validation**, exit 0 (checkpoint 2); the bundle-backed **dry run** produced
    WOULD_INSERT 1 / REVIEW 8 / UNAVAILABLE 1 with **zero database access** (checkpoint 3A); and the
    **database backup** was taken and verified outside the repository (3B preflight).
13. ~~The only remaining operational checkpoint is the separately approved one-ad LIVE INGESTION
    (checkpoint 3B).~~ **DONE — 2026-07-23.** Approved and executed **exactly once**: INSERTED 1,
    REVIEW 8, UNAVAILABLE 1, WRITE_ERROR 0; one atomic `Ad` + `AdAnalysis` insert for
    `3831676167136939`; post-run read-only verification and backup/bundle checksum re-verification all
    passed (§18). **All Phase 1 operational checkpoints are now complete.**

### 0.4b Do-not-repeat

The complete list is **§14**. Read it before proposing any work. Nothing on it may be reopened without a
specific, demonstrated regression.

### 0.5a Phase 1 part 2 files — committed and pushed as `d060a69`

| File | State |
|---|---|
| `lib/analysis/benchmarkContract.ts` | **new** — pure, immutable benchmark enums + relationship tables (tier labels, evidence tokens/labels, confidence-per-source, weights, cardinalities). Imports nothing. Lets the validator check the scorer's guarantees **without a runtime route to the scorer** |
| `lib/analysis/competitorScoring.ts` | modified — **consumes those tables instead of its own literals. No scoring behaviour change**, single source of truth so scorer and validator cannot drift |
| `lib/analysis/browserAnalysisBundle.ts` | modified — additive **schema v3** (`analysis_result` / `benchmark_result`), real-scorer array invariants, media-keyed rubric completeness, exhaustive summary cross-check, benchmark semantic validation, and the `decidePersistence` gate. **v2 semantics untouched.** |
| `lib/analysis/browserIngestBundleMapping.ts` | **new** — pure v3 SUCCESS row → Ad/AdAnalysis payload mapping; bundle-time `benchmarkScoredAt`; required-`adLink` guard |
| `scripts/ingest-browser-collected-ads.ts` | modified — **bundle-backed**; all AI/scorer/browser routes removed; **sidecar bound to the bundle's declaration**; injected **lazy** `DbFactory` |
| `scripts/preview-browser-collected-ads.ts` | modified — writes **v3**, serialising the already-computed result |
| `tests/browser-ingest-from-bundle.test.ts` | **new** — 171 tracked tests |
| `tests/browser-analysis-bundle.test.ts` | modified — the 153 v2 tests pinned explicitly to `BUNDLE_SCHEMA_V2` (assertions unchanged) |
| `package.json` | modified — `test:browser-ingestion-bundle` |
| `docs/PROJECT_STATUS.md` | modified — this tracker |

**Unchanged by design:** `prisma/schema.prisma`, all migrations, all UI, capture/discovery, the Vision
prompt and parser, the scheduler, the Meta API path, `lib/analysis/bundleAssembly.ts`,
`lib/analysis/sourceRowIdentity.ts`, `scripts/plan-browser-ingest-from-bundle.ts` and
`scripts/validate-browser-analysis-bundle.ts` (a v3 row is a superset, so assembly, planning and
validation needed no change).

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
| **Committed baseline** | **`27c7c0e`** — `feat: add ReviewCandidate model and review contract` (Phase 2 checkpoint 2.2). **`main` and `origin/main` are both at `27c7c0e`.** Phase 1 production baseline remains `d060a69`; Phase 2 checkpoint 2.1 is `15584ec`. |
| Phase 1 part 1 | `3cedf83` — reviewed (Codex PASS), committed, pushed, **frozen** (§14) |
| Phase 1 part 2 | `d060a69` — schema v3 + bundle-backed ingestion. Five Codex NEEDS CHANGES reviews, five corrections, coordinator-verified, committed and pushed. Safeguards **frozen** (§14). **No formal Codex PASS was issued** — see the §14 note |
| Application | Local-first Next.js 14 (App Router) |
| Database | Prisma ORM over SQLite (`prisma/dev.db`, local) |
| Collection policy | Browser-first canonical; Meta API diagnostic only |
| Canonical workflow ends at | An opt-in **checksummed schema-v3 bundle** that ingestion consumes. **Exercised end to end on 2026-07-23**: a real paid-preview bundle drove one approved live database ingestion (checkpoint 3B) |
| Ingestion path | **Bundle-backed**, with **no route to Anthropic, Vision or scoring recomputation**. Run live **once** (checkpoint 3B, 2026-07-23): one atomic `Ad` + `AdAnalysis` insert for `3831676167136939` |

**Working tree:** tracked files clean; `main` level with `origin/main` at `27c7c0e`. The `ReviewCandidate`
migration is **applied** to `prisma/dev.db` (2026-07-23; integrity ok; table empty). The known protected
untracked paths remain present and untouched (`AGENTS.md`, `dir`, `findstr`, `git`,
`scripts/_orig_check.ts`).

Phase 1 parts 1 and 2 are both committed, pushed and frozen, and **all Phase 1 operational checkpoints
(1, 2, 3A, 3B preflight and 3B) are COMPLETE** — see §3 and §18.

---

## 3. Executive status

**What works today.** A local Next.js/Prisma app with live, database-backed pages for competitors,
industries, ads, stored analysis, captured evidence and a Meta-API review queue. A substantial
browser-first collection pipeline: discovery with scope proof and five-state classification,
CSV validation, asset capture for image/carousel/video, fail-closed footer provenance, and a
spend-guarded Vision preview with a no-spend preflight.

**The architecture on `origin/main` today (`d060a69`).** The reusable handoff is committed, pushed and
frozen, and the repeat-charge path is gone:

- `browser:preview` can **opt in** (`AI_PREVIEW_OUTPUT_FILE`) to writing a **checksummed schema-v3
  reusable analysis bundle** carrying the validated analysis, the complete benchmark result and
  per-row visual confidence.
- `browser:ingest` **consumes that validated bundle** and has **no route to Anthropic, Vision, the
  static/video analysers or benchmark recomputation** — there is no recompute fallback.
- **Schema v2 remains validation/planning-only and can never persist**; **schema v3 is required for any
  INSERT**.
- **LOW visual confidence routes the row to REVIEW and makes it unwritable.** Visual confidence is
  **bundled and operationally enforced**, but is **not separately persisted as its own Prisma field**.

**The operational gap is now closed.** A real schema-v3 bundle was produced by an approved paid preview,
validated offline, and carried through a zero-database dry run, with the database backed up (checkpoints
1, 2, 3A and the 3B preflight — §18). On 2026-07-23 the **approved one-ad live ingestion (checkpoint 3B)
ran exactly once** and inserted `3831676167136939` (one atomic `Ad` + `AdAnalysis`; INSERTED 1, REVIEW 8,
UNAVAILABLE 1, WRITE_ERROR 0), with post-run verification and backup/bundle checksum re-verification all
passing. **All Phase 1 operational checkpoints are complete.**

**What is partial.** Competitor management (view/edit Meta config only), browser ingestion (writes
`Ad` + `AdAnalysis` but no run boundary), the review queue (Meta API only), the
dashboard and ad detail (live but not source-aware), `ScanRun` support (Meta only), and the one-command
workflows (discovery → preview only).

**The three largest structural gaps:**

1. ~~No reusable analysis bundle produced by a REAL paid preview, and no approved live ingestion run.~~
   **CLOSED.** The architecture is committed, pushed and frozen (parts 1 and 2): preview can save a
   checksummed schema-v3 bundle carrying visual confidence and the complete model output, and ingestion
   consumes it with no Anthropic call. A real paid-preview bundle now exists (checkpoint 1), and the
   approved live database ingestion ran once (checkpoint 3B, 2026-07-23 — §18). This is no longer a gap;
   the remaining structural gaps below (Phases 2–3) are unaffected.
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
| Visual confidence **display** (HIGH/MEDIUM/LOW, fail-closed to LOW; separate from benchmark confidence) | parser + `scripts/preview-browser-collected-ads.ts` | `6564b41` | Displayed in preview and **carried in the bundle** (v2 and v3). **LOW is unwritable — it routes that row to REVIEW** (`d060a69`). Still not written to a database column | Display frozen; DB persistence outstanding (Phase 2) |
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
| Browser ingestion | **Bundle-backed (`d060a69`):** per-row transaction inserting `Ad` + `AdAnalysis`; triple-flag live-write guard; duplicate isolation; verified-ACCEPT-only headline/description; **no Anthropic call and no recomputation on any path**; LOW visual confidence routes to REVIEW and is unwritable; bundle-time `benchmarkScoredAt` | No `ScanRun`; verification reasons still not persisted; browser review states still not persisted (Phase 2). **Never run live against a database** | `scripts/ingest-browser-collected-ads.ts` | The repeat-charge gap is closed in code; `ScanRun` remains Phase 3 | No |
| Meta review queue | `/meta-review` lists Meta `PENDING`; approve/reject persists `reviewStatus` + `qualified`; server-side score check | Meta-API only; no browser ads; no note/reviewer/timestamp/override; no ingestion gate | `app/meta-review/page.tsx`, `lib/queries/pendingAds.ts`, `app/api/ads/[id]/review/route.ts` | **Yes** (Phase 2) | No |
| Dashboard + ad detail | Live Prisma queries; filters (industry, qualified, source, format, score, search); full stored analysis, AIDA, triggers, benchmark, asset gallery, card grid | Dashboard defaults to all ads incl. pending/rejected; no visual-confidence display; no review actions; no provenance labels | `app/page.tsx`, `app/ads/[id]/page.tsx`, `app/components/DashboardFilter.tsx` | No | Yes (Phase 4) |
| ScanRun support | Schema models exist (`ScanRun`, `AdScanRecord`); Meta ingestion + seed create and complete runs; `getScanRunById()` exists | Browser ingestion creates **none** (verified: 0 references); no run-detail page; removed/skipped/capture/analysis counts absent; a failure can leave a run `IN_PROGRESS` | `prisma/schema.prisma`, `lib/ingestion/metaIngestion.ts`, `lib/queries/scanRuns.ts`, `scripts/ingest-browser-collected-ads.ts` | **Yes** (Phase 3) | No |
| One-command browser workflows | `browser:workflow-one` / `workflow-db-one` / `workflow-client` chain discovery → validate → capture → validate → preview; continue-on-failure across competitors | No validation decision, ingestion, cards or display stage; no durable checkpoint/resume; preview can print FAIL without a non-zero exit when row errors are collected | `scripts/run-one-competitor-browser-workflow.ts`, `run-db-competitor-browser-workflow.ts`, `run-client-browser-workflow.ts` | Phase 5 | Yes |
| Asset / card ingestion | `browser:ingest-cards` upserts `AdCreativeCard` idempotently by `(adId, cardIndex)`; FK-safe (never creates Ads) | Separate command, not part of one atomic run; card text not re-gated against verified-meta ACCEPT | `scripts/ingest-ad-creative-cards.ts` | Phase 3 | Yes |
| Visual-confidence persistence | Parsed, displayed in preview, and **carried per row in the bundle contract**. **Operationally enforced (`d060a69`): LOW is unwritable and routes that row to REVIEW** | **Not a Prisma field**, not in the review queue, not in the ad UI. "Bundled and enforced" is not the same as "separately persisted" — no `Ad`/`AdAnalysis` column stores it | `lib/analysis/creativeAssetAnalyser.ts`, `scripts/preview-browser-collected-ads.ts`, `lib/analysis/browserAnalysisBundle.ts` | Phase 2 (DB field + queue) | Partly |
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
| **LOW_VISUAL_CONFIDENCE** | Preview display **+ carried in the bundle contract** (v2 and v3) | Video parser returns HIGH/MEDIUM/LOW; the bundle stores it per row | **Not as its own DB field** — it lives in the bundle, not in `Ad`/`AdAnalysis` | Preview terminal only; no UI | **Yes (`d060a69`)** — LOW is **unwritable** and routes that row to REVIEW | Persist as a DB field and surface it in a review queue. Note: `benchmarkConfidence=LOW` is a **different** concept (evidence source, not visual certainty) |

### Recorded inconsistency (verified)

Browser ingestion inserts `reviewStatus: 'PENDING'` (line 860) while setting `qualified` directly
from analysis (line 862). Because `/meta-review` rejects non-`meta_api` ads, **a browser ad can be
simultaneously `PENDING` and `qualified`, with no available review action.** This must be resolved in
Phase 2 — either by a source-neutral queue or by an explicit browser decision lifecycle.

---

## 7. Analysis reuse and repeated-charge risk

**This is the immediate architectural priority.**

**Status: CLOSED in code by Phase 1 part 2 (`d060a69`, committed and pushed). Never exercised against a real paid preview or a real database. Kept here as the record of
what the defect was and how it was closed.**

The original verified problems:

- Preview results were **printed only** — never saved.
- Visual confidence was **transient** — parsed, displayed, discarded.
- **No bundle, checksum or saved analysis artifact existed** anywhere in the repository.
- `scripts/ingest-browser-collected-ads.ts` invoked `resolveCreativeContext()` again (**line 695**),
  calling Anthropic Vision for every asset-backed row.
- **Dry-run ingestion still called Anthropic.** The three live-write flags gate DB writes, not spend.
- **Scoring ran before duplicate detection** — `resolveCreativeContext()` at line 695 preceded the dedup
  query `prisma.ad.findMany` at **line 756**, so an ad already in the database could **incur another
  Vision charge before being skipped as a duplicate**.

How part 2 closed it:

- Preview saves a validated **v3** bundle (opt-in); ingestion consumes it and **never analyses anything**.
- Ingestion has **no route to Anthropic, the analyser, the scorer, fetch or Playwright at all**, so
  there is no optional external work left that could precede dedup — the ordering defect cannot recur.
- **Dry-run costs nothing and contacts no database.** Visual confidence is carried by the bundle, and
  LOW routes to REVIEW rather than a write.
- Spend confirmation/cap/exact-ID filtering remain **preview-side**, which is now the only place spend
  can occur.

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
- **Visual confidence is not persisted in the database** — it is displayed in preview and carried in the
  bundle, and LOW routes a row to REVIEW so it can never be ingested (`d060a69`), but no
  `Ad`/`AdAnalysis` column stores it. Persisting it is Phase 2.
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

### Phase 1 — Reusable analysis handoff  ← **ACTIVE and PARTIAL** (parts 1 and 2 both committed, pushed and frozen; no real paid-preview bundle and no live ingestion run yet)

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
- **Part 2 (`d060a69`, committed and pushed):** schema **v3** (`analysis_result` / `benchmark_result` carrying the
  complete computed scorer + benchmark output), the `decidePersistence` gate (v2 = planning-only, never
  writable), the pure `browserIngestBundleMapping.ts`, and a **bundle-backed
  `scripts/ingest-browser-collected-ads.ts`** with an injected database boundary and no AI/scorer/browser
  route at all, a bundle-declared-only sidecar binding, a lazy database factory, and benchmark validation
  against the shared pure contract. 171 tracked tests, including executable scorer→validator parity.
- **Work remaining before Phase 1 is complete:** none — the operational sequence is finished.
  1. ~~Part 2 must be reviewed, verified, committed and pushed.~~ **DONE** — `d060a69`.
  2. ~~No bundle produced by a real paid preview exists yet.~~ **DONE** — an approved paid preview
     produced the **first real schema-v3 bundle** for `3831676167136939` (checkpoint 1); it passed
     offline validation (checkpoint 2), a zero-database dry run (checkpoint 3A) and the backup preflight
     (3B preflight). See §18.
  3. ~~Live ingestion has never been run against the database — the only remaining item.~~ **DONE —
     checkpoint 3B, 2026-07-23.** Approved and executed **exactly once**: INSERTED 1, REVIEW 8,
     UNAVAILABLE 1, WRITE_ERROR 0; one atomic `Ad` + `AdAnalysis` insert for `3831676167136939`; post-run
     verification and backup/bundle checksum re-verification all passed. See §18.
- **Dependencies:** existing planner/parser and exact-ID filter (both complete).
- **Completion criteria:** preview can explicitly save a validated result ✅; a matching valid bundle causes
  **zero** Anthropic calls ✅ (planner, proven by tracked import-boundary test); stale/mismatched bundles and
  row-level drift fail closed ✅; exact selected ad IDs recorded ✅; deterministic scores and visual
  confidence preserved ✅; **the real ingestion path consumes the bundle ✅ (part 2 — implemented,
  committed and pushed as `d060a69`, and exercised end to end on 2026-07-23: a real paid-preview bundle
  drove one approved live database ingestion — checkpoint 3B, §18)**. **All completion criteria and
  operational checkpoints are met; Phase 1 operational work is complete.**
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

> ### Phase 1 — Reusable analysis handoff · **COMPLETE (operational)** — part 1 DONE (frozen), part 2
> committed and pushed as `d060a69`, and all operational checkpoints (1, 2, 3A, 3B preflight, 3B) done.
> **Next active work is Phase 2 (§11).**

**Phase 1's production code and operational checkpoints are COMPLETE.** Part 1 — the bundle, validator,
planner and 153 tracked tests — is reviewed (Codex PASS), committed (`3cedf83`), pushed and frozen (§14).
Part 2 — schema v3 and bundle-backed ingestion, 171 further tracked tests — is committed and pushed as
`d060a69` and frozen (§14). The operational sequence is finished:

1. ~~Part 2 is uncommitted and awaiting verification.~~ **DONE** — committed and pushed as `d060a69`;
   its safeguards are frozen (§14).
2. ~~No reusable bundle from a real paid preview exists.~~ **DONE** — checkpoint 1 produced the first
   real schema-v3 bundle, checkpoint 2 validated it, checkpoint 3A's dry run passed with zero database
   access, and the 3B preflight backup was verified (§18).
3. ~~Live ingestion has never run against the database — the only remaining item.~~ **DONE — checkpoint
   3B, 2026-07-23.** The approved one-ad live ingestion ran **exactly once**: INSERTED 1, REVIEW 8,
   UNAVAILABLE 1, WRITE_ERROR 0; one atomic `Ad` + `AdAnalysis` insert for `3831676167136939` (§18).

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

> **DELIVERED (part 2) — implemented 2026-07-17, corrected across five Codex NEEDS CHANGES rounds,
> committed and pushed as `d060a69`. The approved one-ad live ingestion (checkpoint 3B) then RAN ONCE on
> 2026-07-23 (§18), so no Phase 1 operational task is outstanding — the next work is Phase 2 (§11).** The
> spec below is what was built to, retained for reference.
>
> **Integrate the validated bundle into the real ingestion path without another AI call.**
> Make `scripts/ingest-browser-collected-ads.ts` consume a validated bundle instead of calling
> `resolveCreativeContext()` (line 695), so a Vision charge can never precede the line-756 duplicate
> check — and so dry-run ingestion costs nothing. Reuse `loadBundle()`, `bundleRowIdentity()` and
> `sourceRowIdentityMismatch()`; fail closed on a missing/invalid/stale bundle with **no** recompute
> fallback. Keep the triple-flag live-write guard, READY-only eligibility and verified-ACCEPT-only
> metadata. No Prisma/schema change. Add tracked tests for the new ingestion path.
>
> **How it was actually delivered, and the one deviation:** the mapping audit gate failed first — schema
> v2 could not truthfully fill seven required non-null `AdAnalysis` fields — so the approved design added
> **schema v3** (v2 frozen, planning-only, never writable) carrying the complete computed scorer and
> benchmark output. Ingestion now has no route to any analysis code at all rather than merely calling it
> later, and the injected database boundary means dry-run performs **zero** database calls (so it no
> longer reports duplicates — it says so). See §0.2 and §19.
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

**Phase 1 part 2 — the schema-v3 handoff and bundle-backed ingestion. FROZEN on 2026-07-17** at
`d060a69`. Five Codex reviews (each NEEDS CHANGES, each closed by a correction pass) · coordinator
verification ✅ · committed ✅ · pushed ✅ · 324 tracked tests passing ✅.

> **Honest caveat on the gate.** Part 1 was frozen under this section's original rule: *a Codex PASS
> **and** a committed, pushed change*. **Part 2 has no formal Codex PASS** — reviews 4 and 5 accepted the
> production implementation and tests but recorded NEEDS CHANGES for test/tracker accuracy, and no PASS
> was ever issued. The coordinator closed the gate under the **lean workflow**, substituting their own
> verification for the formal PASS. That is a deliberate, operator-approved variation, recorded here
> rather than papered over as a PASS. Anyone auditing Part 2 should know its evidence is: five review
> rounds with every finding corrected, coordinator verification, and 324 tracked tests — **not** a Codex
> PASS.

Do not redesign, rebuild or re-litigate any of the following without a specific, demonstrated regression:

- `lib/analysis/benchmarkContract.ts` — the complete pure semantic contract (thresholds, weights,
  labels, formulas, warnings, rounding and the derivations), and the fact that `competitorScoring.ts`
  now PRODUCES with those same functions (values identical; scoring behaviour unchanged).

- Bundle **schema v3** — the `analysis_result` / `benchmark_result` blocks, their exact-key/enum/range
  validation, the completeness rules, the summary-vs-authoritative cross-check, and the benchmark
  semantic verification against the pure contract (thresholds, weights, formula, score, tier,
  recommended_use, warning).
- The **persistence gate** (`decidePersistence`) and the rule that **v2 can never authorise an INSERT**.
- `lib/analysis/browserIngestBundleMapping.ts` — the bundle → Ad/AdAnalysis payload mapping.
- The **bundle-backed `scripts/ingest-browser-collected-ads.ts`**, its injected database boundary, and
  its ordering guarantees.
- The **v3 preview writer** and the renamed `recommendations.headline_recommendation` /
  `description_recommendation` keys (see the note in §19).
- `tests/browser-ingest-from-bundle.test.ts` — the 171 tracked Part 2 tests, including the test-only
  Prisma schema reader behind the AdAnalysis drift assertion.

Both parts of Phase 1 are now frozen. Part 1 met the original rule (Codex PASS + committed + pushed);
Part 2 was closed under the lean workflow described above (coordinator verification + committed +
pushed, **no formal Codex PASS**).

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
| 2026-07-23 | Ingestion | Live browser ingestion against the database | **VERIFIED — ran once** | **Checkpoint 3B** executed 2026-07-23: INSERTED 1, REVIEW 8, UNAVAILABLE 1, WRITE_ERROR 0; one atomic `Ad` + `AdAnalysis` insert for `3831676167136939`; see the dedicated Checkpoint 3B row below |
| — | Ingestion | Card ingestion inside one atomic run | **Not yet verified** | Not implemented |
| — | Review | Browser review states | **Not yet verified** | Do not exist |
| — | Scheduler | Scheduled execution | **Not yet verified** | Cron disabled |
| `3cedf83` | Phase 1 | `npm run test:browser-bundle` — bundle schema, validator, source binding, planner, atomic write + cleanup/verification reporting, held-only assembly | **PASS — 153 tests, 0 fail, 0 skipped** | **Repo-verifiable** — the suite is tracked at `3cedf83`. 87 → 139 → 153 across the two correction rounds |
| `3cedf83` | Phase 1 | `npx tsc --noEmit --incremental false`; `git diff --check` | PASS (exit 0) | **Repo-verifiable** — run on the exact tree that was committed |
| `d060a69` | Phase 1 part 2 | `npm run test:browser-bundle` — the 153 part-1 tests, unchanged, now pinned explicitly to schema v2 | **PASS — 153 tests, 0 fail, 0 skipped** | v2 behaviour is provably unchanged by the v3 addition |
| `d060a69` | Phase 1 part 2 | `npm run test:browser-ingestion-bundle` — schema v3 completeness, the persistence gate, the pure mapping, and the ingestion orchestration against an injected fake database | **PASS — 171 tests, 0 fail, 0 skipped** | **324 tracked tests total.** Covers the nine corrections, the benchmark semantic contract, and executable scorer→validator parity. No real database, browser, asset or network was touched; the fake DB counts client construction too |
| `d060a69` | Phase 1 part 2 | `npx tsc --noEmit --incremental false`; `git diff --check` | PASS (exit 0) | **Repo-verifiable** |
| 2026-07-17 | Phase 1 part 2 | **Codex review 1** | **NEEDS CHANGES** | **Operator-reported.** Architecture confirmed sound; zero-database dry-run accepted as safer. Nine findings → **correction pass 1 completed** (§19) |
| 2026-07-17 | Phase 1 part 2 | **Codex review 2** (of correction pass 1) | **NEEDS CHANGES** | **Operator-reported.** All other boundaries pass. One material blocker: the benchmark validator accepted impossible combinations (score 6.4 + tier MODERATE) → **correction pass 2 completed** (§19) |
| 2026-07-17 | Phase 1 part 2 | **Codex review 3** (of correction pass 2) | **NEEDS CHANGES** | **Operator-reported.** No production-code defect. Two accuracy findings: an overstated scorer/validator parity test, and contradictory tracker statements → **correction pass 3 completed** (§19) |
| 2026-07-17 | Phase 1 part 2 | **Codex review 4** (of correction pass 3) | **NEEDS CHANGES** | **Operator-reported.** No production-code defect. The 6.4 negative regression was ambiguous, and live tracker sections still contradicted each other → **correction pass 4 completed** (§19) |
| 2026-07-17 | Phase 1 part 2 | **Codex review 5** (of correction pass 4) | **NEEDS CHANGES — tracker accuracy only** | **Operator-reported.** **The production implementation and tests are ACCEPTED.** Three stale current-state tracker sections remained (stable baseline, executive workflow, fourth-review history) → reconciled in correction pass 5 (§19) |
| 2026-07-17 | Phase 1 part 2 | `npm run test:browser-ingestion-bundle` — executable parity: the production `scoreCompetitorBenchmarkAd()` output for ASSET/MANUAL/FALLBACK, validated by the schema-v3 validator | **PASS — 171 tests, 0 fail, 0 skipped** | Proves the shipping scorer's output is accepted verbatim, and that a mutated scorer value is rejected |
| 2026-07-17 | Phase 1 part 2 | **Final coordinator verification** | **COMPLETE** | Codex raised no production-code defect in reviews 3–5. The coordinator verified the final documentation correction and closed the review gate under the **lean workflow**. **No formal Codex PASS was issued for Part 2** — see the §14 caveat |
| 2026-07-17 | Phase 1 part 2 | Commit + push | **DONE** | `d060a69` — `feat: add bundle-backed browser ingestion (Phase 1 part 2)`; `ed71513..d060a69`, fast-forward. `origin/main` = `d060a69`; local `main` verified level. Safeguards frozen (§14) |
| 2026-07-17 | **Checkpoint 1** | **First real schema-v3 bundle from an approved paid preview** — one ad, `3831676167136939` (VIDEO, `creative_source: ASSET`), from `data/imports/castlery-cmp23o62-browser-collected-ads.with-assets.csv` | **PRODUCED — SUCCESS 1, REVIEW 0, SKIPPED 0, ERROR 0** | **Operator-run** from an authorised shell. Visual confidence **HIGH**. Bundle stored **outside the repository**: `CherieTCTCT-phase1-checkpoint1-3831676167136939-v3.json` on the Desktop, **15,127 bytes**, SHA-256 `413185a1e6a1d5fcfcf6ab6b6b9cfea1c78546f65292bad7093cd7222b7f3fe6`. The metadata sidecar row is **REVIEW**, so headline and description remain **blank** — correct fail-closed behaviour. **No database or ingestion action occurred** |
| 2026-07-17 | **Checkpoint 2** | **Offline validation** of that bundle — `npm run browser:bundle:validate -- <path>`, full file checks (no `--no-file-checks`) | **PASS — exit code 0** | `VALID — STRUCTURE, SOURCE AND ASSET INTEGRITY VERIFIED`. Schema **v3**. Source CSV and verified-meta sidecar both bound by declared path **and** SHA-256; row identity verified field by field; asset manifest = 4 `frame-NN` files with per-file hash and byte-size checks; VIDEO frame-cardinality rule satisfied (4 of a 4-frame limit); `analysis_result` and `benchmark_result` complete, so **persistence completeness passed**; sensitive-content and forbidden-key safeguards passed. **No external, database, Prisma, browser or paid action occurred** |
| 2026-07-17 | **Checkpoint 3A** | **Bundle-backed ingestion DRY RUN** — `npm run browser:ingest` with `BROWSER_ADS_FILE` + `BROWSER_ANALYSIS_BUNDLE`, all three live-write flags deliberately unset | **PASS — exit code 0; WOULD_INSERT 1, REVIEW 8, UNAVAILABLE 1 (all 10 rows accounted for)** | Target `3831676167136939` became `WOULD_INSERT`. The 8 REVIEW rows are ads the bundle does not cover — correctly held, never auto-analysed. **Database-factory calls 0, database reads 0, database writes 0** (the factory is passed as `null` when `liveWrite` is false, so no Prisma client is constructed); `prisma/dev.db` mtime unchanged. **Duplicate status was NOT checked** — a dry run never contacts the database, so this row is **not** known to be new. **No AI, scorer, analyser, browser or external call occurred.** Bundle and declared source checksums unchanged after the run |
| 2026-07-17 | **Checkpoint 3B preflight** | **Database backup**, performed manually by the operator in Windows Command Prompt using the approved outside-repository procedure | **VERIFIED** | **Operator-reported.** Source `prisma/dev.db`, 700,416 bytes, SHA-256 `abde54bc1a7bd93d7810d40b3946596512028b1d2aacceb57250beec83a6aa98`, copied to `CherieTCTCT-phase1-checkpoint3b-preflight-dev.db` on the Desktop with the **same size and same SHA-256**, and an `FC` byte comparison reporting **no differences encountered**. **No WAL, SHM or journal sidecar was present immediately before copying**, so the single-file copy is complete and consistent. The procedure refuses overwrite and writes outside the repository by design |
| 2026-07-23 | **Checkpoint 3B** | **Live ingestion against the database** — the approved one-ad run for `3831676167136939`, all three live-write flags set, executed **exactly once** | **DONE — INSERTED 1, REVIEW 8, UNAVAILABLE 1, WRITE_ERROR 0** | The duplicate read ran first; the ad did not exist, so **one atomic `Ad` + `AdAnalysis`** was inserted and nothing else. No existing record updated or deleted; **no AI/analyser/scorer/browser/external call**. Post-run read-only query confirmed **adCount 1, analysisCount 1, `adSource` browser_collected, `creativeSource` ASSET, `capturedAssetType` VIDEO_FRAME, headline null, description null**. Database grew **700,416 → 708,608 bytes**, post-run SHA-256 `336e0f6d805e59c27b25b8a3980e9bb8783f712cc70ec91158e7811bb00b2d09`. External backup **unchanged** (700,416 bytes, SHA-256 `abde54bc1a7bd93d7810d40b3946596512028b1d2aacceb57250beec83a6aa98`); bundle **unchanged** (15,127 bytes, SHA-256 `413185a1e6a1d5fcfcf6ab6b6b9cfea1c78546f65292bad7093cd7222b7f3fe6`). No WAL/SHM/journal sidecar remained. No repository file changed; nothing staged, committed or pushed by the run |
| 2026-07-23 | **Phase 2 — 2.1** | Source-neutral review-state contract — commit + push | **DONE — `15584ec`** | `feat: add source-neutral review state contract`. Decisions ACCEPT/EXCLUDE only; NOTE is metadata; states PENDING/HELD/ACCEPTED/EXCLUDED; exception categories terminal (`UNAVAILABLE`) / resolution-required (`COMPETITOR_CONFLICT`, `MISSING_ANALYSIS`) / review-overridable (`NEEDS_REVIEW`, `LOW_VISUAL_CONFIDENCE`, `ASSET_COPY_MISMATCH`). Pure module + focused tests; no DB, no schema change |
| 2026-07-23 | **Phase 2 — 2.2** | Independent Codex review → consolidated correction → confirmation | **PASS** | **Operator-reported** (Codex runs outside this repo). One review: 1 BLOCKER (terminal `UNAVAILABLE` was resolvable via `resolveException`) + 2 MATERIAL (delimiter-concatenated Meta key could collide; blank/malformed AdAnalysis content could count as complete). All three corrected in ONE consolidated pass (runtime terminal guard; shared `meta:ad:sha256:<hash>` canonical identity builder used by creation AND validation; Phase-1-faithful prose/JSON-shape analysis validation). Confirmation review returned **PASS**, no new findings |
| 2026-07-23 | **Phase 2 — 2.2** | `npm run test:review-state` + `test:review-candidate-persistence` + both Phase 1 suites; `prisma validate`; `tsc`; `git diff --check` | **PASS — 422 tests (38 + 60 + 153 + 171), 0 fail, 0 skipped** | Phase 1's 324 tests unchanged and green; schema valid; TypeScript exit 0 |
| 2026-07-23 | **Phase 2 — 2.2** | Commit + push | **DONE — `27c7c0e`** | `feat: add ReviewCandidate model and review contract`; 7 files staged by exact name (1,658 insertions / 118 deletions); `15584ec..27c7c0e` fast-forward; `origin/main` = `27c7c0e`, local level. Includes the additive migration `20260723000000_add_review_candidate` (1 table, 2 FKs both **ON DELETE RESTRICT / ON UPDATE CASCADE**, 2 unique + 4 ordinary indexes, no destructive SQL), generated by schema-to-schema diff and **unapplied at commit time** |
| 2026-07-23 | **Phase 2 — migration rehearsal** | `prisma migrate deploy` against a DISPOSABLE copy outside the repo | **PASS** | Backup via the SQLite backup API from a read-only source (integrity ok), rehearsal copy migrated: only the 1 pending migration applied; `ReviewCandidate` created with 0 rows, all 6 named indexes + both FKs correct; Ad 54 / AdAnalysis 54 / Competitor 21 unchanged; `_prisma_migrations` 8 → 9; real `prisma/dev.db` stayed **byte-identical** (SHA-256 `336e0f6d…b2d09`) |
| 2026-07-23 | **Phase 2 — LIVE migration** | `prisma migrate deploy` against the REAL `prisma/dev.db` | **DONE — integrity ok** | Pre-migration DB **708,608 bytes**, SHA-256 `336e0f6d805e59c27b25b8a3980e9bb8783f712cc70ec91158e7811bb00b2d09`; fresh live backup first (SQLite backup API, read-only source): `CherieTCTCT-phase2-live-pre-migration-dev.db`, SHA-256 `fe90378ed556fd8af58d0c382f551b17aebeb02b00276ff66cf77fcfc83c0d35`, **preserved outside the repository**. Post-migration DB **741,376 bytes**, SHA-256 `a29523e1c294d02ada414851fc2a540d852f47a4174c709fd0332bcc4c138f5d`; `integrity_check: ok`; **Ad 54, AdAnalysis 54, Competitor 21 unchanged; `ReviewCandidate` exists with 0 rows; `_prisma_migrations` 9; migration recorded once, finished, not rolled back**; 24 columns, both FKs RESTRICT/CASCADE, six named indexes. No `migrate dev`/`db push`/`generate`/`seed`; no data written |
| 2026-07-23 | **Phase 2 — journal recovery** | Residual `dev.db-journal` (16,928 bytes) left by migrate deploy | **RESOLVED — deleted after verification** | A controlled read-write open proved the journal **non-hot** (no rollback occurred; DB byte-identical; migration intact) but read-only work cannot clear a stale `delete`-mode journal. After exclusive-handle checks (`FileShare.None`, both files unlocked) and hash re-verification, ONLY `prisma/dev.db-journal` was deleted. `dev.db` stayed byte-identical (`a29523e1…`), integrity ok, counts 54/54/21/0/9, migration still recorded once; **no WAL/SHM/journal sidecar remains** |
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
| 2026-07-17 | (uncommitted) | **Phase 1 part 2 — bundle-backed live ingestion, after the mapping audit gate FAILED.** The gate found that schema v2 cannot truthfully populate seven required non-null `AdAnalysis` fields (`creativeAnalysis`, `copyAnalysis`, `headlineAnalysis`, `descriptionAnalysis`, `weaknessesJson`, `improvementsJson`, `rubricScoresJson`): they are scorer OUTPUTS, and v2 carries only a summary. `''`/`[]`/`{}` were rejected as substitutes — `weaknessesJson: '[]'` would assert "no weaknesses found", which is false, and the UI's `??` fallback never fires on an empty string. Implementation stopped; the operator approved the additive fix. **(1) Schema v3** (`lib/analysis/browserAnalysisBundle.ts`): v2 is untouched and still frozen; v3 adds `analysis_result` + `benchmark_result`, faithful mirrors of the `AnalysisOutput` and `CompetitorBenchmark` preview already held in memory, with exact-key/enum/range/bounded-string validation, rubric-completeness and one-format-half rules, the existing secret/base64/raw-response guards extended over the new prose, and a cross-check that the v2-shaped summary cannot contradict the authoritative result. A v3 SUCCESS row missing any required persistence input fails validation. **(2) Persistence gate** (`decidePersistence`): v2 loads, validates and plans but can **never** authorise an INSERT — a would-be writable v2 row becomes `BLOCKED_SCHEMA` with a precise reason and no payload. **(3) Pure mapping** (new `lib/analysis/browserIngestBundleMapping.ts`): one validated v3 SUCCESS row → database-neutral Ad/AdAnalysis payloads; every required field has one authoritative source; `rubricScoresJson` round-trips the scorer's object exactly (v3 stores explicit nulls for completeness, the mapper drops them); nullable columns are null only where the scorer genuinely produced nothing; ACCEPT-only verified metadata; no Prisma/analyser/scorer/Anthropic/Playwright import. **(4) Ingestion refactor** (`scripts/ingest-browser-collected-ads.ts`): every route to `resolveCreativeContext`, `analyseAdRow`, `scoreCompetitorBenchmarkAd`, the analyser, Anthropic and fetch is REMOVED; no recompute fallback; `ANTHROPIC_API_KEY` neither required nor read; Prisma is imported lazily behind the live-write gate; the database boundary is injected (`IngestDb`) so the real orchestration is testable with fakes; order is parse → validate bundle/source/sidecar/assets/identity → decisions → live-write authorisation → competitor resolution → dedup → insert. **Dry run now contacts the database not at all** and says so rather than implying a duplicate check it did not perform. Insert-only preserved: an existing ad is `SKIPPED_EXISTING`, never updated. **(5) v3 preview writer**: serialises the in-memory result; ordinary preview output, preflight write-freeness and held-row honesty unchanged. **Note:** the scorer's `recommendations.headline`/`.description` had to be stored as `headline_recommendation`/`description_recommendation` — a bare `headline`/`description` key is globally forbidden anywhere in a bundle (frozen raw-listing exclusion), and that guard was NOT weakened; the mapper restores the scorer's original shape on write. Tests **153 → 232** (153 part 1 unchanged, pinned explicitly to v2; 79 new), `tsc` exit 0, `git diff --check` exit 0. No paid preview, no Anthropic call, no browser run, no real database access, no Prisma/migration/schema change. | The repeated-charge defect is closed: ingestion contains no optional external work at all, so nothing can be charged before dedup, and dry-run costs nothing | **Independent Codex review of part 2** (immediate action); then commit + push approval; then a separately approved paid preview for the first real v3 bundle; then approved live ingestion (checkpoint A2) |
| 2026-07-17 | (uncommitted) | **Phase 1 part 2 — correction after independent Codex review returned NEEDS CHANGES.** Codex confirmed the architecture sound (zero-AI ingestion, v2 refusal, v3 serialisation, pure mapping, skip-only duplicates, no update path, the transaction boundary, the three live-write flags, per-row isolation, the recommendation rename) and **accepted the zero-database dry-run as safer** — it is not a defect. Nine findings corrected. **(1) Sidecar binding:** ingestion had a duplicate, weaker sidecar parser that auto-discovered the canonical `*.verified-meta.csv` regardless of the bundle, so a sidecar created or edited AFTER the bundle could put advertiser copy into the database that no bundle vouched for. It now loads **only** `bundle.verified_meta_path`, re-checks containment, checksums **the exact bytes it parses** (no time-of-check/time-of-use gap), and reuses the shared strict `loadVerifiedMetaSidecar`; a null declaration means no metadata at all, and there is no discovery path left. **(2) Impossible arrays:** derived from the real analysers — `strengths`/`weaknesses` are never empty (they fall back to an explicit sentence), `improvements` is always exactly 3 (`[recommendations.copy, .headline, .creative]`), and the benchmark `breakdown` is always exactly 3. Empty, blank and wrong-cardinality arrays now fail: `[]` would assert "nothing found", which is false. **(3) Rubric:** completeness is keyed to the row's own `media_type` — IMAGE/CAROUSEL require all 7 static scores with the video half null, VIDEO the reverse; shared scores are never null; unknown keys fail; a genuine 0 survives. **(4) Cross-check:** now exhaustive over all 19 duplicated values (adding AIDA scores, all 7 component scores, behavioural triggers and strengths) using structural equality, so key order cannot create a false mismatch and neither side is silently preferred. **(5) Benchmark semantics:** tier↔tier_token, evidence token/label/confidence/warning all checked against `creative_source`, breakdown cardinality, score and weight ranges, and per-source formula weights — via the new pure `benchmarkContract.ts`, which `competitorScoring.ts` now also consumes (identical values, no behaviour change) so the two cannot drift. **(6) `benchmarkScoredAt`** now carries the validated `bundle.created_at`, not ingestion time; `firstSeenAt`/`lastSeenAt`/`lastSeenActiveAt` remain ingestion time. **(7) Drift detection:** a test-only Prisma schema reader extracts `AdAnalysis`'s required non-null scalars (ignoring comments, attributes, relations, nullables and db-generated fields), excludes `adId`, and compares both directions against the mapper contract; a fixture proves an added column is caught. **(8) Lazy Prisma:** `runIngestion` takes a `DbFactory` and calls it only after the flags, full validation and a genuinely writable row exist — dry-run, invalid bundles, source mismatches, v2 bundles and held-only workloads construct **zero** clients; disconnect only if one was created. **(9) `Ad.adLink`:** a blank `ad_library_url` now makes only that row ERROR rather than reaching a required-column insert; no URL is fabricated and the row contents are never echoed. Tests **232 → 297** (153 part 1 unchanged; part 2 79 → 144). `tsc` exit 0, `git diff --check` exit 0. No paid preview, no Anthropic call, no browser run, no real database access, no Prisma/migration/schema change. | Metadata can no longer come from bytes the bundle never vouched for; placeholder results, incomplete rubrics and contradictory summaries are rejected; the benchmark is no longer misdated; a new required column cannot be silently forgotten. **NOTE: this row's claim that "impossible benchmarks are rejected" was overstated — see the correction below** | **Codex re-review of these nine corrections** (immediate action); then commit + push approval; then a separately approved paid preview for the first real v3 bundle; then approved live ingestion (checkpoint A2) |
| 2026-07-17 | (uncommitted) | **Phase 1 part 2 — benchmark semantic contract, after a second Codex NEEDS CHANGES.** Codex confirmed every other boundary (ingestion, mapping, sidecar, rubric, Prisma, duplicates, transaction, zero-AI) passes, and found **one material blocker**: the benchmark validator checked each field's range and a few pairwise relationships, but accepted benchmark COMBINATIONS the real scorer could never emit — concretely **`benchmark_score: 6.4` with `tier_token: MODERATE`**, when the real threshold is **6.5**, so 6.4 is WEAK. A tracked fixture carried exactly that impossible pair and passed. **Fix:** `lib/analysis/benchmarkContract.ts` is now the COMPLETE pure semantic contract — tier thresholds (≥8.0/≥6.5/≥5.0), token↔label, evidence token/label/confidence/warning per creative source, per-source weights and breakdown labels, the exact formula sentences, the exact warning strings, the clamp+2dp rounding rule, and pure derivations (`deriveTierToken`, `deriveTierLabel`, `deriveEvidenceForCreativeSource`, `deriveBenchmarkBreakdown`, `computeBenchmarkScoreFromBreakdown`, `deriveRecommendedUse`, `roundBenchmarkScore`). **`competitorScoring.ts` now PRODUCES with those same functions** — `benchmarkTierToken` and `recommendedUseFor` delegate to them, and the three scoring branches were replaced by one contract-driven path. Identical arithmetic, thresholds, rounding, formulas, labels, weights, confidences, warnings and guidance: a single-source-of-truth extraction, **not** a scoring change. **[SUPERSEDED CLAIM — this row originally added "asserted behaviourally rather than by source scanning". That was overstated: the parity test of the time called only the pure contract helpers, so it proved the contract agrees with itself, not that the shipping scorer does. A genuine test that invokes `scoreCompetitorBenchmarkAd()` was added in the next row.]** **Validation now recomputes the whole benchmark** from the row's own `analysis_result` + `creative_source` and requires a match: breakdown labels in order, each value traced to its authoritative analysis field (AIDA avg → rounded mean of the four AIDA scores; creative → `creative_score`; copy → `copy_score`; action → `aida_scores.action`), per-source weights, weights summing to the formula total, `benchmark_score` equal to the weighted sum under the scorer's rounding, `tier_token`/`tier` derived from that score's threshold band, `recommended_use` from tier+confidence, and the exact formula and warning strings. A self-consistent benchmark that contradicts `analysis_result` is now rejected. This is deterministic verification against a pure table — no analyser runs and ingestion still has no route to the scorer. **Fixtures are now DERIVED from the contract rather than hand-typed** (which is how the impossible pair appeared): the ASSET fixture is the real 6.1 → WEAK, FALLBACK/MANUAL are 6.3 → WEAK, and 6.4/MODERATE lives on as a negative regression test alongside boundary tests immediately below, at and above every threshold. Also corrected the stale ingestion ordering comment (documentation only — the accepted runtime order is unchanged). Tests **297 → 318** (153 part 1 unchanged; part 2 144 → 165). `tsc` exit 0, `git diff --check` exit 0. No paid preview, no Anthropic call, no browser run, no real database access, no Prisma/migration/schema change. | A bundle can no longer claim a benchmark the scorer could not have produced; scorer and validator share one contract, so they cannot drift | **Focused Codex re-review of this correction** (immediate action); then commit + push approval; then a separately approved paid preview for the first real v3 bundle; then approved live ingestion (checkpoint A2) |
| 2026-07-17 | (uncommitted) | **Phase 1 part 2 — test and tracker accuracy, after a third Codex NEEDS CHANGES.** Codex found **no remaining production-code defect** and required only two corrections; **no production file was changed in this pass.** **(1) Genuine parity test.** The test claiming "the scorer and the validator agree" never invoked `scoreCompetitorBenchmarkAd()` — it called only pure contract helpers against a contract-derived fixture, so it proved the contract agrees with itself, and the tracker's claim of behavioural assertion was overstated (that claim is now marked SUPERSEDED in the row above). Replaced with executable tests that build a synthetic `AnalysisOutput`, call the **production scorer** for **ASSET, MANUAL and FALLBACK**, convert its actual returned `benchmarkScore`/`tier`/`tierToken`/`confidence`/`evidenceSource`/`evidenceToken`/`recommendedUse`/`formula`/`breakdown`/`warning` into a schema-v3 row by shape conversion only (no recomputation, no independent prediction), and assert the **real schema-v3 validator accepts it verbatim**; a mutated scorer-produced value is asserted to fail. Added a positive regression where the production scorer genuinely computes **6.4 → WEAK** (every ASSET term 6.4, so 6.4×0.70 + 6.4×0.20 + 6.4×0.10 = 6.4) — proving 6.4 itself is valid and only **6.4 + MODERATE** is impossible; that negative regression is retained. **(2) Tracker.** Made the review count consistent (three Codex reviews, three corrections, final re-review pending); corrected the visual-confidence rows in §4/§5/§6, which still said it was "not in a bundle" and did "not affect ingestion" — it is carried in the bundle contract and **LOW is unwritable and routes that row to REVIEW**, while still not being a Prisma field; and narrowed the parity claim to exactly what the test covers (the benchmark block, not end-to-end integration). Tests **318 → 324** (153 part 1 unchanged; part 2 165 → 171). `tsc` exit 0, `git diff --check` exit 0. No paid preview, no Anthropic call, no browser run, no real database access, no Prisma/migration/schema change. | Parity is now proven by running the shipping scorer, not by re-deriving it; the tracker no longer contradicts itself or overstates coverage | **Final focused Codex re-review** (immediate action); then commit + push approval; then a separately approved paid preview for the first real v3 bundle; then approved live ingestion (checkpoint A2) |
| 2026-07-17 | (uncommitted) | **Phase 1 part 2 — isolated 6.4 regression and tracker reconciliation, after a fourth Codex NEEDS CHANGES.** No production-code defect; **no production file was changed in this pass** (test + tracker only). **(1) The 6.4 negative test was ambiguous.** It overrode `benchmark_score` to 6.4 and the tier to MODERATE on a row whose authoritative inputs and breakdown compute **6.1**, so validation could reject it because 6.4 disagreed with the computed 6.1 rather than because 6.4 is below the 6.5 MODERATE threshold — it never isolated the rule it claimed to test. Rebuilt as a threshold-only regression: it takes the **same synthetic `AnalysisOutput` as the positive test**, calls the production `scoreCompetitorBenchmarkAd()`, asserts the scorer itself returns `benchmarkScore === 6.4` and `tierToken === 'WEAK'`, builds the schema-v3 row from that exact output, **confirms the unmodified row validates**, then clones it and mutates **only** the tier fields (summary `benchmark_tier`, `benchmark_result.tier_token`, and its label — consistently, so the summary cross-check cannot fire first). The score, breakdown values/labels/weights, formula, evidence, confidence, warning, `recommended_use` and the whole `analysis_result` are the scorer's, untouched. It asserts the error names the expectation — `does not match the tier a score of 6.4 earns (WEAK)` — and asserts the ABSENCE of score/breakdown, summary-contradiction, recommended_use and breakdown errors, plus that **every** reported error concerns the tier. The positive production-scored 6.4 + WEAK test is retained. **(2) Tracker reconciled.** Every live section now uses one count — **four Codex reviews, four corrections, final focused re-review pending**: §0.1 handover, §0.2 phase summary, §0.3 blocked table, §0.4 next task, §11 heading, §12 active phase (also 79 → 171 tests) and §14 all previously disagreed. §3's structural-gap wording no longer claims the reusable bundle/checksummed handoff "does not exist" — the architecture exists locally; what does not exist is a bundle from a real paid preview or any executed live ingestion. Historical rows are preserved, with the superseded parity claim annotated in place. Tests **324** (153 part 1 unchanged; part 2 171). `tsc` exit 0, `git diff --check` exit 0. No paid preview, no Anthropic call, no browser run, no real database access, no Prisma/migration/schema change. **No Codex PASS has been given for Part 2.** | The 6.4 threshold rule is now pinned by a test that can only fail for that rule; the tracker tells one consistent story | **Final focused Codex re-review** (immediate action); then commit + push approval; then a separately approved paid preview for the first real v3 bundle; then approved live ingestion (checkpoint A2) |
| 2026-07-17 | (uncommitted) | **Phase 1 part 2 — tracker reconciliation, after a fifth Codex review (NEEDS CHANGES, tracker accuracy only).** **Codex ACCEPTED the production implementation and the isolated 6.4 regression** — no code defect remained, and **no production or test file was changed in this pass** (docs only). Three stale current-state sections were reconciled. **(1) §2 stable baseline** named `e208cbd` as the latest commit, called the working tree clean, said the canonical workflow ends at terminal output, and said ingestion repeats Vision. It now separates the two layers: the **committed baseline is `ed71513`** (where `origin/main` and `main` both sit), Part 1 is committed/pushed/frozen, and the working tree is **explicitly NOT clean** — it carries the uncommitted Part 2 work, listed file by file (7 modified, 3 new), with the protected untracked paths untouched. **(2) §3 executive workflow** said preview output is only printed, nothing is saved, and ingestion re-calls Anthropic. It now states the committed reality separately from the local Part 2 architecture: opt-in checksummed schema-v3 bundle carrying validated analysis, benchmark and visual confidence; ingestion consumes it with **no route to Anthropic, Vision, the analysers or benchmark recomputation**; **v2 is planning-only and cannot persist, v3 is required for persistence**; **LOW visual confidence routes the row to REVIEW and is unwritable**, and visual confidence is **bundled and enforced but not a separate Prisma field**. The structural-gap wording no longer implies the reusable handoff does not exist — the accurate gap is that **no schema-v3 bundle from a real paid preview exists** and **no approved live ingestion has been executed**. **(3) §18 validation history** recorded only three NEEDS CHANGES reviews and marked the fourth as not performed. It now lists **Codex reviews 1–5, each NEEDS CHANGES, each followed by a completed correction pass**, with the **final tracker-only confirmation PENDING**. Also repaired two doubled bold markers left by an earlier scripted edit, and refreshed §0.2's stale "needs an independent Codex review" wording. Live sections now use one summary throughout: **four completed NEEDS CHANGES reviews, four completed correction passes, final focused confirmation pending.** Historical rows are preserved as written, with superseded claims annotated in place. Validation unchanged and re-confirmed: **Part 1 153, Part 2 171, combined 324 passed; 0 failed; 0 skipped**; `tsc` exit 0; `git diff --check` exit 0. No paid preview, no Anthropic call, no browser run, no real database access, no Prisma/migration/schema change. **Part 2 remains local and uncommitted; NO Codex PASS has been given.** | The tracker no longer contradicts the working tree it describes: committed state, local state and review history all tell the same story | **Final tracker-only Codex confirmation** (immediate action); then commit + push approval; then a separately approved paid preview for the first real v3 bundle; then approved live ingestion (checkpoint A2) |
| 2026-07-17 | `d060a69` | **Phase 1 part 2 committed, pushed and frozen.** After five Codex reviews (each NEEDS CHANGES, each closed by a correction pass) the coordinator verified the final documentation correction and closed the review gate under the **lean workflow**. Ten files staged by exact name — `docs/PROJECT_STATUS.md`, `lib/analysis/benchmarkContract.ts`, `lib/analysis/browserAnalysisBundle.ts`, `lib/analysis/browserIngestBundleMapping.ts`, `lib/analysis/competitorScoring.ts`, `scripts/ingest-browser-collected-ads.ts`, `scripts/preview-browser-collected-ads.ts`, `tests/browser-analysis-bundle.test.ts`, `tests/browser-ingest-from-bundle.test.ts`, `package.json` — 3,963 insertions / 1,157 deletions; the protected untracked paths were never staged. Pushed `ed71513..d060a69` (fast-forward, no force); `origin/main` = `d060a69`, local `main` verified level, tracked tree clean. **§14: the schema-v3 and bundle-backed-ingestion safeguards are now FROZEN** — with an explicit caveat recorded there that **no formal Codex PASS was ever issued for Part 2**; the gate was closed by coordinator verification, not by a PASS, which is a deliberate operator-approved variation on the rule Part 1 followed. This tracker pass reconciled every live section that still said Part 2 was uncommitted, unpushed or awaiting verification: §0 handover, §0.1, §0.2, §0.3 blocked table, §0.4 next task, §0.5a, §2 baseline (now `d060a69`, working tree clean), §3 executive workflow, §4, §5, §6, §7, §10, §11, §12, §13, §14 and §18. **Phase 1 remains ACTIVE and partial**: no schema-v3 bundle has been produced by a real paid preview, and no approved live ingestion run has occurred — both separately approved checkpoints. No production or test file changed in this pass. | Both parts of Phase 1 are on `origin/main` and frozen; the tracker matches the remote | **A separately approved paid preview producing the first real schema-v3 bundle**, then an approved live ingestion run (checkpoint A2) |
| 2026-07-17 | (uncommitted) | **Operational checkpoints 1, 2, 3A and the 3B preflight recorded; `CLAUDE.md` refreshed; a malformed `.gitignore` rule fixed.** Documentation and ignore rules only — **no production code or test changed**. **(1) Checkpoint 1:** the operator ran an approved one-ad paid preview from an authorised shell, producing the **first real schema-v3 bundle** for `3831676167136939` (VIDEO, ASSET, visual confidence HIGH; SUCCESS 1 / REVIEW 0 / SKIPPED 0 / ERROR 0), stored **outside the repository**, 15,127 bytes. Its sidecar row is REVIEW, so headline and description stay blank. **(2) Checkpoint 2:** the tracked standalone validator returned **exit 0** with full file checks — structure, source and sidecar checksum binding, row identity, 4-frame asset manifest, VIDEO cardinality, persistence completeness and the sensitive-content guards all passed. **(3) Checkpoint 3A:** the bundle-backed **dry run** returned exit 0 with **WOULD_INSERT 1, REVIEW 8, UNAVAILABLE 1** and **zero database-factory calls, reads and writes**; duplicate status was **not** checked, so the row is not known to be new. **(4) Checkpoint 3B preflight:** the operator backed up `prisma/dev.db` (700,416 bytes) outside the repository using the approved procedure — same size, same SHA-256, `FC` reporting no differences, and no WAL/SHM/journal sidecar present before copying. **§0.3, §0.4 and §18 updated**; §0.4's next task is now the **one-ad live ingestion**, with its required shape recorded in advance (duplicate read first, skip-not-update, one atomic insert, post-run read-only verification, backup re-checksum). **(5) `CLAUDE.md`** refreshed: its milestone section still described Phase 0 as current, so a fresh session had no idea Phase 1 existed. It now records both Phase 1 parts committed, pushed and frozen at baseline `d80ab94`, the completed checkpoints, the **lean workflow**, and the operational rule that **Claude Code must never assume `ANTHROPIC_API_KEY` is available** — paid previews are operator-run, and the key is never printed or inspected. **(6) `.gitignore` line 10** was malformed: `*.db.backup*data/creative-assets/` concatenated two patterns onto one line, so the generic `*.db.backup*` guard was **dead** (verified: `foo.db.backup-x` was not ignored). Split into a valid `*.db.backup*`; `/data/creative-assets/` already exists separately and was left alone. **No broad `*.json` or `*-v3.json` rule was added** — real bundles stay outside the repository until a dedicated safe directory and naming rule is approved. **(7) Stale current-state references reconciled** (found in a read-only review of this same diff, before it was committed): three live spots still named the paid preview as the upcoming task even though checkpoint 1 was done — §0.2's "immediate action" line, §0.1's canonical-sequence steps 10 and 12, and a superseded paragraph at the end of §0.4. All three now state that checkpoints 1, 2, 3A and the 3B preflight are complete and that **the sole next action is the unapproved one-ad live ingestion**. Historical review history is unchanged; only its current-state interpretation was corrected. **Live ingestion remains unapproved. No database, Prisma, preview, validator, planner, ingestion, browser or external action ran in this pass.** | A fresh session now learns the real state from `CLAUDE.md` and the tracker; the backup guard actually works; no live section contradicts another | **Checkpoint 3B — separately approved one-ad live ingestion** |
| 2026-07-17 | (docs-only, this commit) | **Phase 1 part 1 push finalisation.** `3cedf83` (implementation) and `e208cbd` (the review record) were pushed to `origin/main` — `c69866a..e208cbd`, fast-forward, no force. Verified after the push: `origin/main` = `e208cbd`, both commits present in remote history by ancestry, local `main` level with `origin/main`, tracked files clean. Tracker finalised accordingly: every live-status section now states that Part 1 is reviewed, committed **and pushed**, with **nothing pending** — no review, no commit, no push. §14: the part 1 safeguards **moved from provisional to FROZEN**, the full condition now being met (Codex PASS ✅ · committed ✅ · pushed ✅ · 153 tests ✅) — bundle schema v2; discriminated SUCCESS/REVIEW/SKIPPED/ERROR rows; honest failed-row and selected-ID accounting; strict source/sidecar/asset/per-row-identity validation; asset hash, byte-size, containment and VIDEO frame-limit checks; the pure allowlist and identity helpers; the structural zero-AI/zero-browser/zero-database boundary; the no-write planner; the atomic temp-file writer with fail-closed final verification; and the 153-test tracked suite. The two low-severity preview **presentation** items stay deferred and explicitly outside the frozen-complete list (§10) — they are display-only and are not grounds to reopen part 1. §0.4/§13 set the next exact task: **integrate the validated bundle into the real browser-ingestion path so ingestion reuses approved analysis with no second Anthropic call**, bounded by — no second AI analysis; validate bundle and source identity before planning writes; deduplicate before any optional external work; preserve per-row REVIEW/ERROR isolation; no DB write as part of tracker work; and a **separate explicit instruction required** before that implementation begins. | Phase 1 part 1 is complete, verified on the remote, and frozen against rework | **Phase 1 remains ACTIVE and partial** (part 2 not started): `ingest-browser-collected-ads.ts` is not bundle-backed and still calls `resolveCreativeContext()` at line 695 before dedup at line 756, so it can repeat paid AI; and no bundle from a real paid preview exists yet |
| 2026-07-23 | (uncommitted, docs-only) | **Checkpoint 3B — approved one-ad live ingestion executed and recorded.** The operator approved and ran the bundle-backed live ingestion **exactly once** for ad `3831676167136939`, with all three live-write flags set (`BROWSER_DRY_RUN=false`, `BROWSER_INGEST_WRITE=true`, `BROWSER_INGEST_CONFIRM_DB_WRITES=I_UNDERSTAND`) against the validated schema-v3 bundle and the Castlery source CSV. **Result: INSERTED 1, REVIEW 8, UNAVAILABLE 1, WRITE_ERROR 0.** The duplicate read ran first; the ad did not exist, so **one `Ad` + one `AdAnalysis` were inserted atomically** and nothing else. No existing record was updated or deleted; **no AI, analyser, scorer, browser or external call occurred.** Post-run read-only verification confirmed adCount 1, analysisCount 1, `adSource` browser_collected, `creativeSource` ASSET, `capturedAssetType` VIDEO_FRAME, headline null, description null. The database grew **700,416 → 708,608 bytes**, post-run SHA-256 `336e0f6d805e59c27b25b8a3980e9bb8783f712cc70ec91158e7811bb00b2d09`. The external backup remained unchanged (700,416 bytes, SHA-256 `abde54bc1a7bd93d7810d40b3946596512028b1d2aacceb57250beec83a6aa98`) and the bundle remained unchanged (15,127 bytes, SHA-256 `413185a1e6a1d5fcfcf6ab6b6b9cfea1c78546f65292bad7093cd7222b7f3fe6`). No WAL/SHM/journal sidecar remained. **This documentation pass changed no production code or test** and touched no protected untracked file. Reconciled every live-status section that still called Phase 1 active/partial or checkpoint 3B unapproved: §0 handover header, §0.1, §0.2, §0.3 blocked table, §0.4 next task (and its step-13 sequence), §2 baseline, §3 executive status and structural gaps, §11 Phase 1 work-remaining and completion criteria, §12 active phase, §18 validation log; and `CLAUDE.md`'s current-state paragraph. | **All Phase 1 operational checkpoints (1, 2, 3A, 3B preflight, 3B) are COMPLETE.** The end-to-end canonical workflow — paid-preview bundle → validated ingestion → one atomic DB write — is proven | Phase 1 operational work is complete. **Next: Phase 2 — browser review and exception state (§11).** No further database action is authorised without a new explicit approval |
| 2026-07-23 | `15584ec` | **Phase 2 checkpoint 2.1 — source-neutral review-state contract, committed and pushed.** Pure `lib/analysis/reviewState.ts` + `tests/review-state.test.ts` + one npm script. Decisions are **ACCEPT and EXCLUDE only**; **NOTE is metadata**, never a decision; review states **PENDING / HELD / ACCEPTED / EXCLUDED**; no silent ACCEPTED⇄EXCLUDED switch (explicit reopen only); persistence-neutral candidate value (no Prisma import). Exception taxonomy later finalised in 2.2 as three categories: **terminal** (`UNAVAILABLE` — never acceptable, never resolvable), **resolution-required** (`COMPETITOR_CONFLICT`, `MISSING_ANALYSIS` — ACCEPT blocked while present; `resolveException` removes them without accepting), **review-overridable** (`NEEDS_REVIEW`, `LOW_VISUAL_CONFIDENCE`, `ASSET_COPY_MISMATCH`). | Source-neutral review lifecycle contract exists, tested and frozen in code | Checkpoint 2.2 persistence design |
| 2026-07-23 | `27c7c0e` | **Phase 2 checkpoint 2.2 — `ReviewCandidate` model + pure persistence/payload contracts + additive migration, committed and pushed.** Additive Prisma model `ReviewCandidate` (24 columns; `candidateKey` unique; `promotedAdId` unique; FKs → `Competitor(id)` and `Ad(id)`, both **ON DELETE RESTRICT / ON UPDATE CASCADE**; 4 ordinary indexes). Pure `lib/analysis/reviewCandidatePersistence.ts`: canonical **hashed Meta identity** `meta:ad:sha256:<sha256(canonicalJson({platform, external_ad_id}))>` (one shared builder for creation AND payload validation — no delimiter concatenation, no collision); **advertiser-scoped fallback identity** (platform + advertiser identity + media type + durable content hash; CSV/row/paths/timestamps are provenance only); one schema-versioned **`PromotionPayloadV1`** envelope (immutable Ad content EXCLUDES competitorId/clientId/industryId/reviewStatus/qualified — bound only at promotion; `qualification_recommendation` copied verbatim from the frozen mapping, never recomputed; deterministic canonical-JSON SHA-256 over the whole envelope); **per-field verified-metadata gates** (only `headline_status=ACCEPT` authorises headline, only `description_status=ACCEPT` authorises description; row-level ACCEPTED alone authorises neither; Checkpoint 1's real REVIEW case representable with blank copy); **strict Phase-1-faithful AdAnalysis completeness** (non-blank prose; strengths/weaknesses non-empty string arrays; improvements exactly 3; rubric a non-empty object of finite numbers; malformed JSON/placeholder/empty structures rejected; completeness DERIVED by validation — no trusted boolean). Independent Codex review (**operator-reported**): 1 BLOCKER + 2 MATERIAL, all corrected in one consolidated pass; confirmation **PASS**. **422 tests** (38+60+153+171), `prisma validate` ok, `tsc` 0. | Phase 2 persistence schema and pure contracts exist, reviewed and pushed | Wire live candidate creation; atomic promotion transaction; review queue/UI; Meta-row migration — **none of these exist yet**, each needs its own approval |
| 2026-07-23 | (docs-only, this pass) | **`ReviewCandidate` migration rehearsed, applied live, and journal resolved.** **(1) Rehearsal:** consistent backup via the SQLite backup API from a read-only source (integrity ok), disposable copy migrated — only the pending migration applied; table created empty; all counts unchanged; real DB untouched (byte-identical). **(2) LIVE apply (2026-07-23):** fresh live backup first (`CherieTCTCT-phase2-live-pre-migration-dev.db`, SHA-256 `fe90378e…c0d35`, preserved outside the repo); `prisma migrate deploy` against `prisma/dev.db` — pre **708,608 B / `336e0f6d…b2d09`** → post **741,376 B / `a29523e1…138f5d`**; `integrity_check: ok`; **Ad 54 / AdAnalysis 54 / Competitor 21 unchanged; ReviewCandidate 0 rows; `_prisma_migrations` 9; migration recorded once, finished, not rolled back**; both FKs RESTRICT/CASCADE; six named indexes. **(3) Journal:** migrate deploy left a 16,928-byte `dev.db-journal`; a controlled read-write open proved it **non-hot** (no rollback; DB byte-identical); after exclusive-handle checks it was deleted — only that file; DB re-verified byte-identical and consistent; **no sidecar remains**. **(4) This pass:** tracker updated (§0 header, §0.1, §0.4, §2, §18, §19) and `.gitignore` gained three narrow rules (`prisma/*.db-journal`, `prisma/*.db-wal`, `prisma/*.db-shm`). **Honesty note: checkpoint 2.2 delivers schema + pure contracts only — no live candidate creation, promotion wiring, review UI or Meta-row migration exists yet.** | The Phase 2 persistence layer is live in the development database, empty and verified; SQLite sidecars can no longer surface in `git status` | Phase 2 wiring (candidate creation → promotion → queue/UI → Meta migration), each step separately approved |

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
