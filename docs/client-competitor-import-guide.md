# Client and Competitor Import Guide

This guide covers how to import clients, industries, and competitors from a CSV file using the Phase 6 Step 2 import script.

---

## Overview

The import script reads a CSV file and safely creates or updates:

- **Industries** - created if the industry name does not exist.
- **Clients** - created if the client name does not exist; `What They Sell` updated if the field is currently blank.
- **Competitors** - created under the correct client if they do not already exist. Existing competitors are updated only when new data fills a blank field.

Dry-run is the default mode. No database writes occur unless `CLIENT_IMPORT_CONFIRM_WRITE=true` is explicitly set.

The script also detects suspected duplicates before writes happen, including same Meta Page ID, same Facebook URL, similar competitor names, and repeated websites within the CSV.

---

## CSV format

```text
Client Name,Industry,What They Sell,Competitor Name,Competitor Website,Facebook Page URL,Meta Ad Library URL,Meta Page ID,Notes
```

| Column | Required | Notes |
|---|---|---|
| `Client Name` | Yes | Must match an existing client or will be created |
| `Industry` | Yes | Creates industry if it does not exist. Slug is auto-generated. |
| `What They Sell` | No | Sets client description. Skipped if client already has this field. |
| `Competitor Name` | No | If blank, the row creates/updates the client only |
| `Competitor Website` | No | Used for within-CSV duplicate detection. Not written to DB. |
| `Facebook Page URL` | No | Must start with `https://facebook.com/` or `https://www.facebook.com/` |
| `Meta Ad Library URL` | No | If `Meta Page ID` is blank, `view_all_page_id=<number>` is extracted automatically |
| `Meta Page ID` | No | Must be numeric digits only. Takes priority over URL extraction. |
| `Notes` | No | Free text, not written to DB |

### Rules

- `Client Name` and `Industry` are required on every row.
- A row with `Client Name` and `Industry` but no `Competitor Name` creates or updates the client only. These rows are reported separately as needing competitor discovery.
- `Meta Page ID` must be numeric if provided. The script validates this before importing.
- If `Meta Page ID` column is blank and `Meta Ad Library URL` contains `view_all_page_id=<number>`, the number is extracted and used as the Meta Page ID.
- Existing `Meta Page ID` and `Facebook Page URL` are never overwritten with a blank value.
- If an incoming value conflicts with an existing value, the existing value is kept and the conflict is reported in the summary.
- Competitors imported this way are set to `discoverySource=manual` and `status=APPROVED`.
- Imported competitors with no Meta Page ID can still be imported. They will appear in the missing Meta Page ID section of the summary.
- No automatic Meta scan is triggered by this script.

---

## CSV import formats

There are three practical formats for real client onboarding. Choose based on what data you have at the time of import.

### Format 1 — Minimum viable import

Use this when you only know the client and their industry. Import the client first, then add competitors later.

```
Client Name,Industry,What They Sell,Competitor Name,Competitor Website,Facebook Page URL,Meta Ad Library URL,Meta Page ID,Notes
PCF Singapore,Early Childhood Education,Childcare and preschool services,,,,,,Onboarding - competitors TBD
```

What this does:
- Creates the client record and the industry if neither exists.
- Sets `What They Sell` if the client was just created.
- Reports the row under "Rows with no competitor name" in the dry-run summary.
- No competitor is created. No Meta scan is triggered.

When to use: first pass when the client has been signed but competitor research has not been done yet.

### Format 2 — Meta-ready import

Use this when you have a competitor's name and Meta Page ID. This is the preferred format because it allows the competitor to be queued for Meta Ad Library scanning immediately after import.

```
Client Name,Industry,What They Sell,Competitor Name,Competitor Website,Facebook Page URL,Meta Ad Library URL,Meta Page ID,Notes
PCF Singapore,Early Childhood Education,Childcare and preschool services,My First Skool,https://www.myfirstskool.com,https://www.facebook.com/myfirstskool,,123456789012345,NTUC-backed childcare provider
```

What this does:
- Creates the client and competitor.
- Writes the Meta Page ID so the competitor appears in `npm run meta:ready` output after import.
- Optionally writes the Facebook Page URL.

How to find the Meta Page ID: open the Meta Ad Library, search for the competitor, and copy the numeric ID from the URL (`view_all_page_id=<number>`). You can paste the full URL into the `Meta Ad Library URL` column and leave `Meta Page ID` blank — the script extracts the number automatically.

### Format 3 — Discovery-needed import

Use this when you know competitors exist but have not yet found their Meta Page IDs. Import them now so they appear in the app, then add Meta Page IDs manually later.

```
Client Name,Industry,What They Sell,Competitor Name,Competitor Website,Facebook Page URL,Meta Ad Library URL,Meta Page ID,Notes
PCF Singapore,Early Childhood Education,Childcare and preschool services,Little Greenhouse,https://www.littlegreenhouse.com.sg,,,,Needs Meta Page ID - check Ad Library
```

What this does:
- Creates the competitor with no Meta Page ID.
- Reports the competitor under "Missing Meta Page IDs" in the dry-run summary.
- Competitor will not appear in `npm run meta:ready` until a Meta Page ID is added manually.

How to add a Meta Page ID later: open `/competitors/<COMPETITOR_ID>` in the app and save the Meta Page ID in the Meta configuration card.

---

## How to prepare a real CSV safely

Follow these steps before running any import against a production database.

### Step 1 — Start from the template

Copy the blank template:

```bash
cp data/templates/client-competitor-import.template.csv data/imports/your-client-batch.csv
```

Fill in one row per competitor. Each row must have `Client Name` and `Industry`. All other columns are optional.

### Step 2 — Validate column values before saving

Check each column for common mistakes before the first dry-run:

- **Client Name** — use the exact spelling you want to appear in the app. The script will create a new client if the name does not match an existing record exactly (case-insensitive match is not performed — confirm the exact case used in the database first).
- **Industry** — use a consistent name across all rows for the same industry. Inconsistent spelling creates duplicate industry records.
- **Facebook Page URL** — must start with `https://facebook.com/` or `https://www.facebook.com/`. URLs from Facebook's mobile site (`https://m.facebook.com/`) are not accepted. Remove trailing slashes.
- **Meta Page ID** — digits only. No spaces, no letters, no quotes. If you copy from a spreadsheet, check for invisible characters.
- **Meta Ad Library URL** — paste the full URL from the Meta Ad Library. The script extracts the `view_all_page_id` number automatically. Leave `Meta Page ID` blank if you are using this column.
- **Competitor Website** — used only for within-CSV duplicate detection. Not written to the database. Include it anyway — it helps catch accidental duplicates where two rows have different competitor names but the same site.

### Step 3 — Remove duplicates within the CSV before running

The script will BLOCK rows it detects as duplicates. It is faster to remove them before the dry-run than to fix the CSV after reading the output.

Check for:
- Two rows under the same client with the same Meta Page ID.
- Two rows under the same client with the same Facebook Page URL.
- Two rows under the same client with the same competitor website.
- Two rows with exactly the same competitor name under the same client.

A simple way to check: sort the CSV by `Client Name`, then by `Meta Page ID`, then by `Facebook Page URL` in a spreadsheet, and scan for adjacent matching values.

### Step 4 — Run a dry-run first

Always run dry-run before writing to the database:

```bash
CLIENT_IMPORT_FILE=data/imports/your-client-batch.csv CLIENT_IMPORT_DRY_RUN=true npm run import:clients
```

Review the output before proceeding. Do not run the live import until the dry-run output is clean.

---

## What to check after dry-run and before live import

Work through the dry-run output from top to bottom. Each section tells you something specific.

### Industries that would be created

Confirm the industry names are spelled correctly. An industry created with a typo is not automatically merged with the correct one. If you see a name that is wrong, fix the CSV and re-run dry-run.

### Clients that would be created

Confirm these are truly new clients. If a client already exists in the database with a slightly different spelling, the import will create a second record. Check the exact name against the app before proceeding.

### Clients that would be updated

These clients already exist. The script will only set `What They Sell` if the field is currently blank. No other client fields are modified.

### Competitors that would be created — with missing Meta Page IDs

These competitors will be created but cannot be scanned immediately. Note the names and plan to add their Meta Page IDs manually before running `npm run meta:ready`.

### Competitors that would be updated

These competitors already exist. Only blank fields will be filled in. Review the list to confirm you expect these updates.

### Rows with no competitor name

These are client-only rows. The client record will be created or updated, but no competitor is written. These rows are expected if you are onboarding a client before competitor research is complete.

### BLOCKED rows

Stop here. Do not run the live import if there are BLOCKED rows.

See the BLOCKED resolution section below for how to handle each type.

### WARN rows

These rows will be created in the live import, but they are flagged as likely duplicates. Review each one before proceeding. See the WARN resolution section below.

### INFO rows

Informational only. No action required unless you want to verify the cross-c