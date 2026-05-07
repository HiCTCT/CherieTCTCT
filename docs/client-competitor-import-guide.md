# Client and Competitor Import Guide

This guide covers how to import clients, industries, and competitors from a CSV file using the Phase 6 Step 1 import script.

## Overview

The import script reads a CSV file and safely creates or updates:

- **Industries** — created if the industry name does not exist.
- **Clients** — created if the client name does not exist; `What They Sell` updated if the field is currently blank.
- **Competitors** — created under the correct client if they do not already exist. Existing competitors are updated only when new data fills a blank field.

Dry-run is the default mode. No database writes occur unless `CLIENT_IMPORT_CONFIRM_WRITE=true` is explicitly set.

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
| `Competitor Website` | No | Stored as reference only, not written to DB |
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
- Imported competitors with no Meta Page ID can still be imported — they will appear in the "missing Meta Page ID" section of the summary.
- Competitors are only automatically scanned after import if they already have a confirmed Meta Page ID. No automatic Meta scan is triggered by this script.
- If a competitor name already exists under a different client in the database, this is reported as a cross-client match. If that other record has a Meta Page ID and the current row does not, the Meta Page ID is reused and noted in the summary.

## Commands

### Dry-run (safe, no writes)

```bash
CLIENT_IMPORT_FILE=data/examples/client-competitor-import.example.csv CLIENT_IMPORT_DRY_RUN=true npm run import:clients
```

### Live import (writes to database)

```bash
CLIENT_IMPORT_FILE=data/examples/client-competitor-import.example.csv CLIENT_IMPORT_CONFIRM_WRITE=true npm run import:clients
```

### Your own CSV file

```bash
CLIENT_IMPORT_FILE=/path/to/your-file.csv CLIENT_IMPORT_DRY_RUN=true npm run import:clients
```

If `CLIENT_IMPORT_CONFIRM_WRITE=true` is not set and `CLIENT_IMPORT_DRY_RUN=true` is also not set, the script exits with an error explaining both options.

## Dry-run output

The dry-run summary shows:

- Industries that would be created
- Clients that would be created
- Clients that would be updated (e.g. `What They Sell` would be populated)
- Competitors that would be created, with a warning for any missing Meta Page IDs
- Competitors that would be updated (e.g. Meta Page ID or Facebook URL would be filled)
- Rows with no competitor name — client-only rows that need competitor discovery
- Duplicate rows in the CSV that would be skipped
- Cross-client competitor matches found in the database
- Conflicts between incoming and existing values (existing values always win)
- Total rows processed and `Written to DB: 0`

## Live import output

The live summary shows the same sections, with "would be created/updated" replaced by "created/updated". At the end, if any competitors are missing Meta Page IDs, the summary reminds you to add them via the app and run `npm run meta:ready`.

## After import

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

## Handling duplicate imports

Running the import script twice against the same CSV is safe:

- Industries and clients that already exist are not recreated.
- Competitors that already exist with the same values are skipped and reported as `already exists with same values`.
- Only genuinely new data (e.g. a Meta Page ID added to a previously blank field) will be applied.

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

A row is missing one of these required fields. Check for blank cells or rows with only partial data.

## Example CSV

An example file is available at:

```text
data/examples/client-competitor-import.example.csv
```

This file demonstrates:

- A client with multiple competitors (some with Meta Page IDs, some without)
- A competitor with Meta Page ID extracted from the Meta Ad Library URL column
- Client-only rows with no competitor
- A cross-client competitor (run the import twice to see duplicate detection in action)
