# CLAUDE.md

Project rules for all future Claude Code sessions. Read this before doing any work.

## Project purpose

- Internal Meta Ad Library competitor intelligence project.
- TypeScript / Node, local Git repository.
- **Browser-first collection is canonical.**
- The Meta API is **diagnostic only** and must **never** be presented as a complete
  advertiser inventory.

## Current completed milestone

- **Phase 0 browser-safety validation is complete** for the current purpose.
- Do **not** extend Phase 0, seek more test advertisers, run browser/API diagnostics,
  or run live discovery merely to validate additional theoretical states **unless I
  explicitly request that exact work**.

Validated outcomes:

- **HipVan** — scope-confirmed, capped `PARTIAL_DISCOVERY`.
- **Castlery** — scope-confirmed, capped `PARTIAL_DISCOVERY`.
- **Wellaholic** — scope-confirmed canonical active-scope empty result; **not** "no ads
  anywhere". Zero ads in an exact country/active/all scope is never an inventory verdict.

Recent committed work:

- `46bd9e6` fix: verify ad-level footer context provenance
- `7962dcc` feat: add local Phase 0 browser measurement tools
- `01099a6` feat: recognise canonical empty active ad scopes

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
