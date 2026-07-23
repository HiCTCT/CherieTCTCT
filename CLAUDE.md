# CLAUDE.md

Project rules for all future Claude Code sessions. Read this before doing any work.

## Project purpose

- Internal Meta Ad Library competitor intelligence project.
- TypeScript / Node, local Git repository.
- **Browser-first collection is canonical.**
- The Meta API is **diagnostic only** and must **never** be presented as a complete
  advertiser inventory.

## Current state — read `docs/PROJECT_STATUS.md` for the full picture

**Phase 1 production-code baseline: `d80ab94`.** Later **documentation-only** commits may sit on top of
it, so this is not necessarily the current Git head. **Confirm the actual head with `git status` and
`git log` before starting work** — do not assume this line is the tip.

**Phase 0 browser-safety validation is complete.** Do **not** extend Phase 0, seek more
test advertisers, run browser/API diagnostics, or run live discovery merely to validate
additional theoretical states **unless I explicitly request that exact work**.

Validated Phase 0 outcomes:

- **HipVan** — scope-confirmed, capped `PARTIAL_DISCOVERY`.
- **Castlery** — scope-confirmed, capped `PARTIAL_DISCOVERY`.
- **Wellaholic** — scope-confirmed canonical active-scope empty result; **not** "no ads
  anywhere". Zero ads in an exact country/active/all scope is never an inventory verdict.

**Phase 1 parts 1 and 2 are committed, pushed and FROZEN** (`3cedf83`, `d060a69`):

- a versioned, checksum-validated **browser-analysis bundle** (schema **v3**) carrying the
  complete scorer and benchmark output, plus a strict fail-closed validator;
- **bundle-backed ingestion** — `scripts/ingest-browser-collected-ads.ts` reuses the
  analysis the preview already paid for and has **no route to Anthropic, Vision, the
  analysers, the scorer or benchmark recomputation**, and no recompute fallback;
- **schema v2 is planning-only and can never authorise an INSERT; v3 is required to
  persist**;
- **LOW visual confidence routes a row to REVIEW and makes it unwritable**;
- 324 tracked tests (`npm run test:browser-bundle`, `npm run test:browser-ingestion-bundle`).

Do **not** redesign or "improve" the frozen safeguards without a specific, demonstrated
regression — see the do-not-repeat list in `docs/PROJECT_STATUS.md` §14.

**Phase 1 operational checkpoints are COMPLETE.** Completed checkpoints: a real schema-v3
bundle from an approved paid preview, its offline validation, a bundle-backed dry run
(zero database access), a verified database backup, and — on 2026-07-23 — the **approved
one-ad live ingestion (checkpoint 3B)**. That run executed exactly once for ad
`3831676167136939` and inserted one `Ad` + one `AdAnalysis` atomically (INSERTED 1, REVIEW 8,
UNAVAILABLE 1, WRITE_ERROR 0); no existing record was updated or deleted and no AI, analyser,
scorer, browser or external call occurred. See `docs/PROJECT_STATUS.md` §18.

## Data-safety rules

- Browser listing CSV **headline and description must always remain blank**.
- **Never** store raw browser-listing text as advertiser metadata.
- Exact creative metadata may be stored **only** when independently proven to belong to
  the **same ad card and the target Library ID**.
- Do **not** infer, rewrite, or borrow metadata from adjacent Meta UI.
- **Blank is safer than unproven data.**
- Browser capture, preview, and ingestion safety rules **must not be weakened**.

## Git and file-safety rules

- **Never use `git add .`** — stage only explicitly named files.
- **Never commit or push** without my explicit approval in the current message.
- **Never delete, clean, restore, rename, or modify untracked files** without my explicit
  approval.
- These accidental untracked files are **off-limits** (do not touch, stage, or remove):
  - `dir`
  - `findstr`
  - `git`
  - `scripts/_orig_check.ts`
- Do **not** stage generated CSVs, logs, reports, downloaded assets, databases, or backups.

## Live-run and database rules

- **Never** run live browser discovery, browser asset capture, preview, ingestion, API
  comparison, database, Prisma, migration, or schema commands **unless I explicitly approve
  the exact command or task**.
- **Never write to the database during Phase 0 work.**
- **Never** inspect, print, echo, log, or ask me to paste API tokens, credentials, or
  secrets.

### Paid previews are operator-run

- **Never assume `ANTHROPIC_API_KEY` is available.** It is **absent** from the environment a
  Claude Code session inherits, and the preview script reads `process.env` directly with no
  dotenv loader — so a `.env` file will not help. This is the operating model, not a defect.
- **I run paid previews myself**, from an explicitly authorised shell. Prepare the exact
  command and hand it over; do not try to work around a missing key.
- **Never print, echo, log or inspect the key**, and never ask me to paste it.
- Real analysis bundles are stored **outside the repository** and must never be committed.

## Working method

For **every** task, begin by stating:

1. whether it is a **read-only review**, a **code change**, a **local script run**, or a
   **database action**;
2. the **exact files** that would be affected;
3. the **exact validation commands**;
4. whether **Git staging, commit, or push** is needed.

Then:

- Default to a **read-only review and plan before editing**.
- **Stop after validation** unless I explicitly approve the next step.
- Focus on **progressing real existing HipVan and Castlery ad records safely**, not on
  adding more Phase 0 experiments.

## Lean review workflow

For **major production work**:

1. **Claude implements and self-reviews.**
2. **Codex performs one full review.**
3. **Claude fixes all findings in one consolidated pass.**
4. **Codex performs one focused confirmation.**
5. **Commit only with my explicit approval.**
6. **Push only with separate explicit approval.**

**Documentation-only or wording-only corrections do not require repeated Codex loops.**

Step 3 means *all* findings, and step 1 is where extra rounds are actually prevented.
Phase 1 part 2 took **five** review rounds instead of two because correction passes kept
introducing new problems: a test that claimed to prove scorer/validator parity but never
invoked the production scorer, a negative test that could fail for the wrong reason, and
documentation left contradicting the working tree. Before handing off, self-check exactly
those: does each test fail **only** for the rule it names? Does a test that claims to
exercise production code actually call it? Do all live documentation sections agree with
each other and with the tree? Derive fixture values from the production contract — a
hand-typed benchmark fixture is what smuggled in an impossible score/tier pair that passed
review twice.
