# Client and Competitor Import Guide

This guide covers how to import clients, industries, and competitors from a CSV file using the Phase 6 Step 2 import script.

## Overview

The import script reads a CSV file and safely creates or updates:

- **Industries** - created if the industry name does not exist.
- **Clients** - created if the client name does not exist; `What They Sell` updated if the field is currently blank.
- **Competitors** - created under the correct client if they do not already exist. Existing competitors are updated only when new data fills a blank field.

Dry-run is the default mode. No database writes occur unless `CLIENT_IMPORT_CONFIRM_WRITE=true` is explicitly set.

The script also detects suspected duplicates before writes happen, including same Meta Page ID, same Facebook URL, similar competitor names, and repeated websites within the CSV.

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

### BLOCKED rows

A BLOCKED row is not created in the database, whether in dry-run simulation or live mode.

To resolve a BLOCKED row:

- Remove the row from the CSV if it is a true duplicate.
- Use the same competitor name as the existing record to route through the update path.
- Correct the Meta Page ID or Facebook URL if the incoming data is wrong.

## Commands

### Dry-run, safe with no writes

```bash
CLIENT_IMPORT_FILE=data/examples/client-competitor-import.example.csv CLIENT_IMPORT_DRY_RUN=true npm run import:clients
```

### Live import, writes to database

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
- Clients that would be updated
- Competitors that would be created, with a warning for any missing Meta Page IDs
- Competitors that would be updated
- Rows with no competitor name
- Duplicate rows in the CSV that would be skipped
- Suspected duplicates, including BLOCKED, WARN, and INFO signals
- Conflicts between incoming and existing values
- Total rows processed and `Written to DB: 0`

If any rows are BLOCKED, the footer shows a count and reminds you to fix the CSV before running live.

## Live import output

The live summary shows the same sections, with "would be created/updated" replaced by "created/updated". BLOCKED rows are confirmed as not created. WARN rows are confirmed as created with a review note.

At the end, if any competitors are missing Meta Page IDs or have suspected duplicates, the summary reminds you to review them before running `npm run meta:ready`.

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
- Only genuinely new data, such as a Meta Page ID added to a previously blank field, will be applied.
- Detection signals may still appear on demo rows that intentionally reuse IDs, URLs, or websites.

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

- A client with multiple competitors, some with Meta Page IDs and some without
- A competitor with Meta Page ID extracted from the Meta Ad Library URL column
- Client-only rows with no competitor
- A cross-client competitor example
- Three Phase 6 Step 2 detection demo rows at the bottom:
  - `My First Skool Global` is BLOCKED because it shares a Meta Page ID with `My First Skool`.
  - `My First Skool Alt` is BLOCKED because it shares a Facebook URL with `My First Skool`.
  - `Kiddiwinkie` is WARNED because it shares a website with `Kiddiwinkie Schoolhouse`.
