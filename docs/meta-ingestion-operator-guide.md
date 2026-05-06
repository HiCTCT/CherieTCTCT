# Meta Ingestion Operator Guide

This guide covers the manual Meta Ad Library ingestion workflow for the competitor ad database.

It is written for operators running Phase 4 manually from Codespaces or a local terminal.

## Current Phase 4 capability

The ingestion system can now:

1. Store a competitor Facebook Page URL and Meta Page ID.
2. Fetch Meta ads by saved Meta Page ID.
3. Run separate media-type passes:
   - `IMAGE -> STATIC`
   - `VIDEO -> VIDEO`
4. Follow Meta API pagination safely.
5. Store public Meta Ad Library links.
6. Insert real Meta ads as `reviewStatus=PENDING` and `qualified=false`.
7. Prevent pending ads from entering the qualified library.
8. Verify ingestion safety with `npm run meta:verify`.
9. Reject common CLI mistakes, including putting a Meta token into `COMPETITOR_ID`.

## 1. ID types operators must not confuse

| Type | Example | Meaning | Where it goes |
|---|---|---|---|
| `COMPETITOR_ID` | `cmos9wvfb016dvwmp40ww0ef1` | Your internal database competitor ID | Terminal command |
| Meta Page ID | `932392073525643` | Numeric Facebook Page ID for the advertiser | Competitor Meta configuration page |
| Ad Library ID | `1263753649192669` | One specific ad ID in Meta Ad Library | Stored as `metaAdId`; used in public ad links |
| Meta access token | `EAA...` | API credential for Meta requests | `META_ADLIB_TOKEN` in terminal only |

Important:

- Do not put a Meta token into `COMPETITOR_ID`.
- Do not put a Facebook Page ID into `COMPETITOR_ID`.
- Do not put an Ad Library ID into `COMPETITOR_ID`.
- Do not paste Meta tokens into chat, documents, GitHub, or code.

## 2. Finding the `COMPETITOR_ID`

Open the competitor detail page in the app.

The URL looks like this:

```text
/competitors/cmos9wvfb016dvwmp40ww0ef1
```

The value after `/competitors/` is the database competitor ID:

```text
cmos9wvfb016dvwmp40ww0ef1
```

Use this in terminal commands:

```bash
COMPETITOR_ID=cmos9wvfb016dvwmp40ww0ef1
```

## 3. Finding and saving the Meta Page ID

The Meta Page ID is the numeric Facebook Page ID of the advertiser.

A valid Meta Page ID is numeric only:

```text
932392073525643
```

It is not:

```text
https://www.facebook.com/pcf.sg
```

and it is not:

```text
pcf.sg
```

### Ways to find it

Use whichever method works for the page.

1. Open the advertiser Facebook Page and look for Page transparency or Page information.
2. Open the advertiser in Meta Ad Library and look for a URL containing `view_all_page_id=<number>`.
3. If you manage the page, look in the Facebook Page settings.
4. If your Meta token has the right permission, use Graph API to look up the page username.

### Saving it in the app

Open:

```text
/competitors/<COMPETITOR_ID>
```

Example:

```text
/competitors/cmos9wvfb016dvwmp40ww0ef1
```

In the Meta configuration card, save:

```text
Facebook page URL: https://www.facebook.com/pcf.sg
Meta Page ID: 932392073525643
```

After saving, refresh the page and confirm the Overview shows the saved Meta Page ID.

## 4. Token safety rules

A Meta access token is sensitive.

Rules:

1. Use the token only in your terminal command.
2. Never paste the token into chat.
3. Never commit the token.
4. Never save the token in a markdown guide.
5. Never put the token into `COMPETITOR_ID`.
6. If the token is exposed, revoke or regenerate it immediately.
7. Check Git history before pushing if you are unsure.

Useful audit command:

```bash
git log -S EAA --all
```

If this returns results involving a real token, treat the token as exposed.

## 5. Safe dry-run workflow

Always dry-run first.

Use this command format:

```bash
COMPETITOR_ID=<database_competitor_id> META_ADLIB_TOKEN=<meta_token> META_DRY_RUN=true META_SEARCH_TERMS='' META_FETCH_LIMIT=25 npm run meta:ingest
```

Example structure:

```bash
COMPETITOR_ID=cmos9wvfb016dvwmp40ww0ef1 META_ADLIB_TOKEN=<meta_token> META_DRY_RUN=true META_SEARCH_TERMS='' META_FETCH_LIMIT=25 npm run meta:ingest
```

Do not include the angle brackets when using a real token.

Correct:

```bash
META_ADLIB_TOKEN=EAAXXXXXXXXX
```

Wrong:

```bash
META_ADLIB_TOKEN=<NEW_TOKEN>
```

### Successful dry-run output should show

```text
Mode:          DRY RUN (no DB writes)
Passes:        IMAGE -> STATIC, VIDEO -> VIDEO
Written to DB: 0
```

For a page with real video ads, you may see:

```text
VIDEO -> VIDEO: processed 3, inserted 0, seen 0, errored 0
```

Dry-run must never write to the database.

## 6. Live write workflow

Only run live write after dry-run looks correct.

Remove `META_DRY_RUN=true`:

```bash
COMPETITOR_ID=<database_competitor_id> META_ADLIB_TOKEN=<meta_token> META_SEARCH_TERMS='' META_FETCH_LIMIT=25 npm run meta:ingest
```

Example structure:

```bash
COMPETITOR_ID=cmos9wvfb016dvwmp40ww0ef1 META_ADLIB_TOKEN=<meta_token> META_SEARCH_TERMS='' META_FETCH_LIMIT=25 npm run meta:ingest
```

Successful live write output may show:

```text
Inserted: <metaAdId>
```

or, if the ads already exist:

```text
Updated lifecycle (SEEN): <metaAdId>
```

`SEEN` is good. It means the system recognised a duplicate and did not insert the same Meta ad again.

## 7. Verification workflow

After every live write, run:

```bash
COMPETITOR_ID=<database_competitor_id> npm run meta:verify
```

Example:

```bash
COMPETITOR_ID=cmos9wvfb016dvwmp40ww0ef1 npm run meta:verify
```

Successful output:

```text
Total violations: 0
Overall result: PASS
```

The verification script checks:

1. `adSource` is `meta_api`.
2. Review status is controlled.
3. Pending ads are not qualified.
4. Approved high-scoring ads are promoted correctly.
5. `metaAdId` is present.
6. `competitorId` is present.
7. Stored ad links do not contain `access_token=`.
8. `metaAdId` values are unique.

## 8. Review queue workflow

Start the app:

```bash
npm run dev
```

Open:

```text
/meta-review?competitorId=<database_competitor_id>
```

Example:

```text
/meta-review?competitorId=cmos9wvfb016dvwmp40ww0ef1
```

Pending Meta ads appear here.

Important behaviour:

- Low-scoring approved ads become tracking-only.
- Tracking-only means `reviewStatus=APPROVED` but `qualified=false`.
- Pending ads never enter the qualified library.
- Rejected ads leave the queue but remain stored for deduplication/history.

## 9. Pagination behaviour

`META_FETCH_LIMIT` is the total maximum ads per media-type pass.

Example:

```bash
META_FETCH_LIMIT=25
```

This means:

- Up to 25 IMAGE ads may be fetched and stored as `STATIC`.
- Up to 25 VIDEO ads may be fetched and stored as `VIDEO`.

The fetcher follows Meta pagination until:

1. The configured limit is reached.
2. No next page exists.
3. A page returns 0 ads.
4. The 10-page safety cap is reached.

The system never logs or stores Meta's raw `paging.next` URL because it can contain the access token.

## 10. Common errors and fixes

### `COMPETITOR_ID env var is required`

Cause:

You ran `npm run meta:ingest` without setting `COMPETITOR_ID`.

Fix:

```bash
COMPETITOR_ID=<database_competitor_id> npm run meta:ingest
```

### `COMPETITOR_ID looks like a Meta access token`

Cause:

You pasted the Meta token into `COMPETITOR_ID`.

Fix:

Use:

```bash
COMPETITOR_ID=<database_competitor_id> META_ADLIB_TOKEN=<meta_token> npm run meta:ingest
```

If the token was exposed, regenerate it.

### `COMPETITOR_ID does not look like a valid database competitor ID`

Cause:

The value is not shaped like a database competitor ID.

Fix:

Use the `id` from the Competitor table or the competitor detail URL.

### `No Competitor found`

Cause:

The database competitor ID does not exist in the current database.

Fix:

Check the competitor detail URL or Prisma Studio.

### `This object does not exist or does not support this action`

Cause:

The Meta Page ID is wrong, fake, inaccessible, or not supported by the API.

Fix:

Confirm the competitor's saved Meta Page ID is the real numeric Facebook Page ID.

### `Ads fetched: 0`

Cause:

The API call worked, but Meta returned no matching ads for that page, country, media type, and search term.

Fix:

Try:

```bash
META_SEARCH_TERMS=''
```

Then rerun dry-run.

### `Updated lifecycle (SEEN)`

Cause:

The Meta ad already exists in the database.

Fix:

No fix needed. This confirms deduplication works.

### `Failed to execute 'json' on 'Response': Unexpected end of JSON input`

Cause:

The Meta configuration form tried to parse an empty or non-JSON response.

Fix:

This was fixed in the Meta config JSON response handling patch. Pull latest `main`.

### `TOKEN SAFETY VIOLATION`

Cause:

A stored Meta API ad link contains `access_token=`.

Fix:

Stop ingestion and investigate immediately. Stored reviewer links should be public Meta Ad Library URLs:

```text
https://www.facebook.com/ads/library/?id=<metaAdId>
```

## 11. Final Phase 4 completion checklist

Before closing Phase 4, confirm:

- [ ] GitHub `main` is synced.
- [ ] Codespaces is on `main` and clean.
- [ ] Windows command prompt is on `main` and clean.
- [ ] Competitor has a real Meta Page ID saved.
- [ ] Dry-run works with real Meta API token.
- [ ] Live write works.
- [ ] `meta:verify` returns `Overall result: PASS`.
- [ ] `/meta-review?competitorId=<id>` shows pending ads or correct reviewed state.
- [ ] No token has been committed or stored in logs.

## 12. Phase 4 boundary

Phase 4 ends when manual Meta ingestion is safe and repeatable.

Do not include these in Phase 4:

- Scheduled scans.
- Multi-competitor automation.
- Creative thumbnail extraction.
- Image/video file storage.
- Full operator dashboards.
- Bulk competitor imports.

These belong in later phases.
