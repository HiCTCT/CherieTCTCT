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

Create the imports folder if it does not exist, then copy the blank template:

```bash
mkdir -p data/imports
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

A BLOCKED row is not written to the database in dry-run or live mode. It indicates a duplicate signal that the script treats as conclusive. See [How to handle BLOCKED rows](#blocked-rows-1) below.

### WARN rows

These rows will be created in the live import, but they are flagged as likely duplicates. Review each one before proceeding. See [How to handle WARN rows](#warn-rows-1) below.

### INFO rows

Informational only. No action required unless you want to verify the cross-client relationship is expected. The same advertiser appearing under multiple clients is normal in most categories.

### Conflicts

A conflict means an incoming value differs from an existing value for the same competitor. The existing value is kept. Review each conflict to confirm the existing value is correct. If the existing value is wrong, update it manually in the app after import.

---

## How to handle BLOCKED, WARN, and INFO outputs

### BLOCKED rows

A BLOCKED row is not written to the database in dry-run or live mode.

| Cause | How to fix |
|---|---|
| Same Meta Page ID as an existing competitor under the same client | Remove the row if it is a true duplicate. If the incoming name is a variant of the existing name, use the existing name instead so the row routes through the update path. |
| Same Facebook Page URL as an existing competitor under the same client | Same resolution as above. |
| Same Meta Page ID as another row in the CSV, under the same client | Keep only one row. Remove the other, or correct the Meta Page ID if one of them is wrong. |
| Same Facebook Page URL as another row in the CSV, under the same client | Keep only one row. |

After fixing a BLOCKED row, re-run dry-run to confirm the block is cleared before running live.

### WARN rows

A WARN row is created in the live import. The flag means the script is not certain it is a duplicate, but the signal is strong enough to review before acting on the data.

| Cause | What to check |
|---|---|
| Similar normalised name under the same client (e.g. `Castlery SG` vs `Castlery Singapore`) | Open the app and check if a record already exists. If it does, remove the row from the CSV and update the existing record manually if needed. If it does not exist, the WARN is a false positive — safe to proceed. |
| Same competitor website as another row in the CSV | Check whether the two rows are the same advertiser with different names, or genuinely different advertisers that share a website. If the same advertiser, keep only one row and use the most accurate name. |

### INFO rows

An INFO signal means the same entity appears under a different client. This is expected when a brand competes in multiple markets and is tracked across multiple client accounts.

Examples of expected INFO signals:
- A skincare brand tracked under two beauty clients.
- A childcare group tracked under two education clients.

If you see an INFO signal for a competitor that should not exist under another client, investigate whether the data under the other client is accurate. INFO rows do not affect the current import.

---

## Commands

### Dry-run, safe with no writes

```bash
CLIENT_IMPORT_FILE=data/imports/your-client-batch.csv CLIENT_IMPORT_DRY_RUN=true npm run import:clients
```

### Live import, writes to database

```bash
CLIENT_IMPORT_FILE=data/imports/your-client-batch.csv CLIENT_IMPORT_CONFIRM_WRITE=true npm run import:clients
```

### Using the example file

```bash
CLIENT_IMPORT_FILE=data/examples/client-competitor-import.example.csv CLIENT_IMPORT_DRY_RUN=true npm run import:clients
```

If `CLIENT_IMPORT_CONFIRM_WRITE=true` is not set and `CLIENT_IMPORT_DRY_RUN=true` is also not set, the script exits with an error explaining both options.

---

## Duplicate detection

The script performs multi-signal duplicate detection across both the current CSV and the existing database. Each detected signal is classified as **BLOCKED**, **WARN**, or **INFO**.

### Signal reference

| Signal | Scope | Action | Reason |
|---|---|---|---|
| Same Meta Page ID, different name | Same client | **BLOCKED** | Meta Page ID is the advertiser identifier. Two names with the same ID under the same client are the same entity. |
| Same Facebook Page URL, different name | Same client | **BLOCKED** | A Facebook Page belongs to one advertiser. Two names sharing the same URL under the same client are duplicates. |
| Same Meta Page ID, different name | Cross-client | INFO | Same advertiser tracked under multiple clients. Expected in some categories. |
| Same Facebook Page URL, different name | Cross-client | INFO | Informational only. |
| Same normalised name, different exact name | Same client | WARN | Likely the same advertiser with a name variant, such as `Castlery SG` vs `Castlery Singapore`. Row is created but flagged. |
| Same normalised name, different exact name | Cross-client | INFO | Informational only. |
| Exact name | Cross-client | INFO | Same competitor tracked under multiple clients. Expected. Meta Page ID may be carried over automatically. |
| Same website within CSV | Any | WARN | Two rows in the same file share a website. Row is created but flagged. |

### Name normalisation

Competitor names are normalised for fuzzy matching only. The original name is always stored unchanged.

Normalisation strips common legal suffixes, geographic qualifiers, and punctuation.

Examples:

- `Castlery SG` becomes `castlery`
- `Castlery Singapore` becomes `castlery`
- `Castlery Pte Ltd` becomes `castlery`
- `Dr Jart+ Singapore` becomes `dr jart`
- `My First Skool` stays `my first skool`

If the normalised form of an incoming competitor matches an existing competitor under the same client, the row is still created but a WARN is shown. If the normalised forms match under a different client, an INFO is shown.

### Meta Page ID reuse from cross-client exact name match

If a competitor name exists exactly under a different client, and that existing record has a Meta Page ID that the incoming row does not, the Meta Page ID is carried over automatically.

This is the only case where automatic reuse occurs. The output labels it clearly so you can verify the advertiser identity.

Fuzzy name matches and URL-only matches are never auto-reused. Those require manual action.

---

## Dry-run output

The dry-run summary shows:

- Industries that would be created
- Clients that would be created
- Clients that would be updated
- Competitors that would be created, with a warning for any missing Meta Page IDs
- Competitors that would be updated
- Rows with no competitor name
- Duplicate rows in the CSV that would be skipped
- Suspected duplicates, including BLOCKED, WARN, and INFO signals
- Conflicts between incoming and existing values
- Total rows processed and `Written to DB: 0`

If any rows are BLOCKED, the footer shows a count and reminds you to fix the CSV before running live.

---

## Live import output

The live summary shows the same sections, with "would be created/updated" replaced by "created/updated". BLOCKED rows are confirmed as not created. WARN rows are confirmed as created with a review note.

At the end, if any competitors are missing Meta Page IDs or have suspected duplicates, the summary reminds you to review them before running `npm run meta:ready`.

---

## After import

### Run the import readiness check

After a live import, run the readiness check to confirm what was created and identify anything that still needs attention:

```bash
npm run import:check
```

To scope the report to a single client or industry:

```bash
CHECK_CLIENT="PCF Singapore" npm run import:check
CHECK_INDUSTRY="Early Childhood Education" npm run import:check
```

The report shows:

- Summary counts of clients, competitors, Meta Page IDs, and Facebook URLs
- All clients and their competitor counts
- Competitors ready for Meta scan (have a Meta Page ID — matches what batch scan will touch)
- Competitors missing a Meta Page ID
- Competitors with a Facebook URL but no Meta Page ID — with direct Ad Library search links
- Competitors with a Meta Page ID but no Facebook URL
- Possible duplicate names under the same client
- Possible duplicate Meta Page IDs under the same client
- All manually imported competitors
- Recommended next steps

The check is read-only. It does not write to the database or call the Meta API.

### Check which competitors are ready to scan

```bash
npm run meta:ready
```

This shows competitors that have a confirmed Meta Page ID and are ready for Meta Ad Library ingestion. Competitors without Meta Page IDs will not appear here.

### Add Meta Page IDs for missing competitors

Open the competitor detail page in the app:

```text
/competitors/<COMPETITOR_ID>
```

Save the Meta Page ID in the Meta configuration card. Once saved, the competitor will appear in `npm run meta:ready` output.

### Run a batch scan

Once Meta Page IDs are set:

```bash
META_ADLIB_TOKEN=<token> META_DRY_RUN=true npm run meta:batch
```

Then confirm and run live:

```bash
META_ADLIB_TOKEN=<token> META_BATCH_CONFIRM_LIVE=true npm run meta:batch
```

---

## Handling duplicate imports

Running the import script twice against the same CSV is safe:

- Industries and clients that already exist are not recreated.
- Competitors that already exist with the same values are skipped and reported as `already exists with same values`.
- Only genuinely new data, such as a Meta Page ID added to a previously blank field, will be applied.
- Detection signals may still appear on demo rows that intentionally reuse IDs, URLs, or websites.

---

## Common errors

### `CLIENT_IMPORT_FILE is required`

You did not set the file path. Add `CLIENT_IMPORT_FILE=<path>` to the command.

### `Live import writes are blocked unless CLIENT_IMPORT_CONFIRM_WRITE=true is set`

You ran the script without a mode flag. Add either `CLIENT_IMPORT_DRY_RUN=true` or `CLIENT_IMPORT_CONFIRM_WRITE=true`.

### `Import file not found`

The file path does not exist. Check the path and try again.

### `Meta Page ID must contain digits only`

The value in the `Meta Page ID` column contains non-numeric characters. Check the CSV for stray characters, quotes, or spaces.

### `Facebook Page URL must start with https://facebook.com/ or https://www.facebook.com/`

The URL format is not valid. Correct the URL or leave the field blank if unknown.

### `Client Name is required` / `Industry is required`

A row is mis
A row is missing one of these required fields. Check for blank cells or rows with only partial data.

---

## Example CSV

An example file is available at:

```text
data/examples/client-competitor-import.example.csv
```

This file demonstrates:

- A client with multiple competitors, some with Meta Page IDs and some without
- A competitor with Meta Page ID extracted from the Meta Ad Library URL column
- Client-only rows with no competitor
- A cross-client competitor example
- Detection demo rows at the bottom:
  - `My First Skool Global` is BLOCKED because it shares a Meta Page ID with `My First Skool`.
  - `My First Skool Alt` is BLOCKED because it shares a Facebook URL with `My First Skool`.
  - `Kiddiwinkie` is WARNED because it shares a website with `Kiddiwinkie Schoolhouse`.

---

## Blank template

A blank template is available at:

```text
data/templates/client-competitor-import.template.csv
```

Use this as the starting point for every real client batch. Copy it, fill it in, run dry-run, then run live.
