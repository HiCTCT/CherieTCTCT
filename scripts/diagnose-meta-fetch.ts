/**
 * Meta Fetch Diagnostic Script
 *
 * Tests 8 parameter combinations directly against the Meta Ad Library API
 * to isolate which filter is causing 0 results for a given advertiser.
 *
 * No Prisma. No DB reads. No DB writes. No simulation fallback.
 * Token is required — script exits immediately if META_ADLIB_TOKEN is absent.
 * Token is redacted from every printed URL.
 *
 * Usage (Windows):
 *   set META_ADLIB_TOKEN=<token>
 *   set META_DIAG_PAGE_ID=374586035998186
 *   set META_DIAG_SEARCH_TERMS=Castlery
 *   set META_DIAG_COUNTRY=SG
 *   npm run meta:diagnose
 *
 * Optional overrides:
 *   META_DIAG_PAGE_ID       Page ID to test (default: 374586035998186)
 *   META_DIAG_SEARCH_TERMS  Keyword(s) to test in search_terms (default: Castlery)
 *   META_DIAG_COUNTRY       ISO country code (default: SG)
 */

import { redactToken } from '@/lib/providers/meta/redact';

// ─── Constants ────────────────────────────────────────────────────────────────

const META_API_BASE = 'https://graph.facebook.com/v25.0/ads_archive';
const DIAG_LIMIT = 5; // small limit — enough to confirm results exist, fast to fetch

const FIELDS = [
  'ad_creation_time',
  'ad_delivery_start_time',
  'ad_delivery_stop_time',
  'ad_snapshot_url',
  'page_id',
  'page_name',
  'ad_creative_bodies',
  'ad_creative_link_titles',
  'ad_creative_link_descriptions',
  'publisher_platforms',
].join(',');

// ─── Types ────────────────────────────────────────────────────────────────────

type DiagAdRecord = {
  id?: string;
  page_name?: string;
  page_id?: string;
  ad_creative_bodies?: string[];
  publisher_platforms?: string[];
};

type DiagApiResponse = {
  data?: DiagAdRecord[];
  error?: { message: string; code: number; type?: string };
};

type TestCase = {
  id: string;
  label: string;
  searchTerms: string;
  pageId: string | null;
  mediaType: string | null;
  adActiveStatus: 'ALL' | 'ACTIVE';
};

type AdSample = {
  id: string;
  page_name: string;
  page_id: string;
  platforms: string;
  copy_preview: string;
};

type TestResult = {
  testCase: TestCase;
  count: number;
  samples: AdSample[];
  redactedUrl: string;
  error: string | null;
};

// ─── API call ─────────────────────────────────────────────────────────────────

async function runTest(
  testCase: TestCase,
  token: string,
  country: string,
): Promise<TestResult> {
  const params = new URLSearchParams({
    search_terms: testCase.searchTerms,
    ad_reached_countries: `['${country}']`,
    ad_active_status: testCase.adActiveStatus,
    ad_type: 'ALL',
    fields: FIELDS,
    limit: String(DIAG_LIMIT),
    access_token: token,
  });

  if (testCase.pageId !== null) {
    params.set('search_page_ids', `[${testCase.pageId}]`);
  }

  if (testCase.mediaType !== null) {
    params.set('media_type', testCase.mediaType);
  }

  const url = `${META_API_BASE}?${params.toString()}`;
  const redactedUrl = redactToken(url);

  try {
    const response = await fetch(url);
    const json = (await response.json()) as DiagApiResponse;

    if (json.error) {
      const safeMsg = redactToken(
        `API error (code ${json.error.code}): ${json.error.message}`,
      );
      return { testCase, count: 0, samples: [], redactedUrl, error: safeMsg };
    }

    const data = json.data ?? [];

    const samples: AdSample[] = data.slice(0, 3).map((r) => ({
      id: r.id ?? '(no id)',
      page_name: r.page_name ?? '(no page_name)',
      page_id: r.page_id ?? '(no page_id)',
      platforms: (r.publisher_platforms ?? []).join(', ') || '(none)',
      copy_preview: (() => {
        const body = r.ad_creative_bodies?.[0] ?? '';
        return body.length > 60 ? body.slice(0, 60) + '…' : body || '(no copy)';
      })(),
    }));

    return { testCase, count: data.length, samples, redactedUrl, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      testCase,
      count: 0,
      samples: [],
      redactedUrl,
      error: `Fetch error: ${redactToken(message)}`,
    };
  }
}

// ─── Print helpers ────────────────────────────────────────────────────────────

function printResult(result: TestResult): void {
  const { testCase, count, samples, redactedUrl, error } = result;

  const statusIcon = error ? '✗' : count > 0 ? '✓' : '○';
  const countLabel = error ? `ERROR` : `${count} ad(s) returned`;

  console.log(`\n  ${statusIcon} ${testCase.id}: ${testCase.label}`);
  console.log(`    Result:  ${countLabel}`);
  console.log(`    URL:     ${redactedUrl}`);

  if (error) {
    console.log(`    Error:   ${error}`);
    return;
  }

  if (samples.length === 0) {
    console.log('    Samples: (none)');
    return;
  }

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    console.log(
      `    [${i + 1}] id=${s.id}  page_name="${s.page_name}"  page_id=${s.page_id}  platforms=${s.platforms}`,
    );
    console.log(`        copy: "${s.copy_preview}"`);
  }
}

function printDiagnosis(results: TestResult[], searchTerms: string, pageId: string): void {
  const LINE = '─'.repeat(63);
  console.log(`\n${'═'.repeat(63)}`);
  console.log('  DIAGNOSIS');
  console.log('═'.repeat(63));

  const get = (id: string) => results.find((r) => r.testCase.id === id);
  const hit = (id: string) => (get(id)?.count ?? 0) > 0;
  const err = (id: string) => get(id)?.error !== null;

  const t1 = hit('T1'); // keyword only
  const t2 = hit('T2'); // page ID only
  const t3 = hit('T3'); // keyword + page ID
  const t4 = hit('T4'); // page ID + IMAGE
  const t5 = hit('T5'); // page ID + VIDEO
  const t8 = hit('T8'); // page ID + ACTIVE

  const findings: string[] = [];

  if (!t1 && !t2) {
    findings.push(
      `⚠  Both keyword-only (T1) and page-ID-only (T2) returned 0. ` +
      `The page ID ${pageId} may be incorrect, or the advertiser has no ads in SG matching these params. ` +
      `Verify the page ID directly in the Meta Ad Library browser interface.`,
    );
  } else if (t2 && !t3) {
    findings.push(
      `✓  Page ID alone (T2) works — the page ID ${pageId} is valid.`,
    );
    findings.push(
      `✗  search_terms="${searchTerms}" + page ID (T3) returns 0. ` +
      `CONFIRMED: search_terms is filtering out all ads. ` +
      `The ad copy does not contain the keyword "${searchTerms}". ` +
      `Fix: use search_terms="" (empty string) in the ingestion config.`,
    );
  } else if (!t2 && t1) {
    findings.push(
      `✗  Page ID only (T2) returns 0 — page ID ${pageId} may be wrong or unused.`,
    );
    findings.push(
      `✓  Keyword-only (T1) finds ads with search_terms="${searchTerms}". ` +
      `The advertiser runs ads but the stored page ID does not match. ` +
      `Check the actual page ID from T1 sample page_id values above.`,
    );
  }

  if (t2 && !t4 && !t5) {
    findings.push(
      `✗  IMAGE pass (T4) and VIDEO pass (T5) both return 0 despite T2 returning ads. ` +
      `CONFIRMED: ads exist but are neither IMAGE nor VIDEO (likely CAROUSEL_IMAGE or CAROUSEL_VIDEO). ` +
      `Fix: add a third pass with no media_type filter, or change media_type to omit the filter entirely.`,
    );
  } else if (t2 && (t4 || t5)) {
    const formats = [t4 && 'IMAGE', t5 && 'VIDEO'].filter(Boolean).join(' and ');
    findings.push(
      `✓  ${formats} pass(es) return ads when search_terms is empty. ` +
      `The two-pass ingestion structure is correct for this advertiser once search_terms is fixed.`,
    );
    if (!t4 || !t5) {
      const missing = !t4 ? 'IMAGE' : 'VIDEO';
      findings.push(
        `○  ${missing} pass returns 0 with empty search_terms — this format may not be used by this advertiser.`,
      );
    }
  }

  if (t2) {
    const t2count = get('T2')?.count ?? 0;
    const t8count = get('T8')?.count ?? 0;
    if (t8count > t2count) {
      findings.push(
        `○  ACTIVE filter (T8) returns more ads than ALL (T2) — unexpected. ` +
        `Check if the API is paginating differently. Both return at most ${DIAG_LIMIT} in this diagnostic.`,
      );
    } else if (t8count === 0) {
      findings.push(
        `○  ACTIVE-only filter (T8) returns 0 despite T2 having results — ` +
        `all found ads may be inactive. The browser "Active ads" count may be counting differently.`,
      );
    } else {
      findings.push(
        `✓  ACTIVE filter (T8) also returns ads — active ads exist under this page ID.`,
      );
    }
  }

  if (findings.length === 0) {
    findings.push('All tests returned 0. Check token validity and page ID before further investigation.');
  }

  console.log('');
  for (const f of findings) {
    console.log(`  ${f}`);
    console.log('');
  }

  console.log(LINE);
  console.log('  Next step based on findings:');
  console.log(LINE);

  if (!t2 && !t1) {
    console.log('  1. Verify page ID in Meta Ad Library: https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=SG&q=Castlery&search_type=keyword_unordered');
    console.log('  2. Look at the URL of any Castlery ad — the advertiser\'s page ID is in view_all_page_id= param.');
  } else if (t2 && !t3) {
    console.log('  1. Change ingestion to use search_terms="" (empty string) with search_page_ids only.');
    console.log('  2. Re-run dry-run to confirm ads are now returned.');
    if (!t4 && !t5) {
      console.log('  3. Also add a third pass with no media_type to capture carousel ads.');
    }
  } else if (!t2 && t1) {
    console.log('  1. Find correct page ID from T1 sample output (page_id field).');
    console.log('  2. Update competitor.metaPageId in the database with the correct ID.');
    console.log('  3. Re-run this diagnostic to confirm T2 returns results.');
  } else {
    console.log('  Review test results above and compare T6/T7 (current behaviour) against T2–T5.');
  }

  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const LINE = '═'.repeat(63);

  const token = process.env.META_ADLIB_TOKEN?.trim();
  if (!token) {
    console.error('\n❌ META_ADLIB_TOKEN is required for diagnostic mode.');
    console.error('   This script makes real API calls — simulation is not supported.');
    console.error('');
    console.error('   set META_ADLIB_TOKEN=<your_token>&& npm run meta:diagnose');
    process.exit(1);
  }

  const pageId = (process.env.META_DIAG_PAGE_ID ?? '374586035998186').trim();
  const searchTerms = (process.env.META_DIAG_SEARCH_TERMS ?? 'Castlery').trim();
  const country = (process.env.META_DIAG_COUNTRY ?? 'SG').trim();

  console.log(`\n${LINE}`);
  console.log('  Meta Fetch Diagnostic');
  console.log(LINE);
  console.log(`  Page ID:      ${pageId}`);
  console.log(`  Search terms: "${searchTerms}"`);
  console.log(`  Country:      ${country}`);
  console.log(`  Limit/test:   ${DIAG_LIMIT} ads`);
  console.log(`  ad_type:      ALL (fixed)`);
  console.log(`  Tests:        8 combinations`);
  console.log(`  DB writes:    0`);
  console.log(`  Token:        present (redacted in all output)`);
  console.log(LINE);

  // ── Test matrix ──────────────────────────────────────────────────────────────

  const tests: TestCase[] = [
    {
      id: 'T1',
      label: `search_terms="${searchTerms}" only — no page ID, no media_type, status=ALL`,
      searchTerms,
      pageId: null,
      mediaType: null,
      adActiveStatus: 'ALL',
    },
    {
      id: 'T2',
      label: `page_id=${pageId} only — empty search_terms, no media_type, status=ALL`,
      searchTerms: '',
      pageId,
      mediaType: null,
      adActiveStatus: 'ALL',
    },
    {
      id: 'T3',
      label: `search_terms="${searchTerms}" + page_id — no media_type, status=ALL`,
      searchTerms,
      pageId,
      mediaType: null,
      adActiveStatus: 'ALL',
    },
    {
      id: 'T4',
      label: `page_id only + media_type=IMAGE — empty search_terms, status=ALL`,
      searchTerms: '',
      pageId,
      mediaType: 'IMAGE',
      adActiveStatus: 'ALL',
    },
    {
      id: 'T5',
      label: `page_id only + media_type=VIDEO — empty search_terms, status=ALL`,
      searchTerms: '',
      pageId,
      mediaType: 'VIDEO',
      adActiveStatus: 'ALL',
    },
    {
      id: 'T6',
      label: `CURRENT PASS 1: search_terms="${searchTerms}" + page_id + media_type=IMAGE, status=ALL`,
      searchTerms,
      pageId,
      mediaType: 'IMAGE',
      adActiveStatus: 'ALL',
    },
    {
      id: 'T7',
      label: `CURRENT PASS 2: search_terms="${searchTerms}" + page_id + media_type=VIDEO, status=ALL`,
      searchTerms,
      pageId,
      mediaType: 'VIDEO',
      adActiveStatus: 'ALL',
    },
    {
      id: 'T8',
      label: `page_id only — empty search_terms, no media_type, status=ACTIVE`,
      searchTerms: '',
      pageId,
      mediaType: null,
      adActiveStatus: 'ACTIVE',
    },
  ];

  // ── Run tests sequentially ───────────────────────────────────────────────────

  console.log('\n  Running tests...\n');

  const results: TestResult[] = [];

  for (const testCase of tests) {
    process.stdout.write(`  Running ${testCase.id}... `);
    const result = await runTest(testCase, token, country);
    results.push(result);
    process.stdout.write(
      result.error
        ? `ERROR\n`
        : result.count > 0
          ? `${result.count} ad(s)\n`
          : `0 ads\n`,
    );
  }

  // ── Print detailed results ───────────────────────────────────────────────────

  console.log(`\n${LINE}`);
  console.log('  DETAILED RESULTS');
  console.log(LINE);

  for (const result of results) {
    printResult(result);
  }

  // ── Summary table ────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(63)}`);
  console.log('  SUMMARY TABLE');
  console.log('═'.repeat(63));
  console.log('');
  console.log(`  ${'Test'.padEnd(4)}  ${'Ads'.padStart(4)}  Description`);
  console.log(`  ${'─'.repeat(60)}`);

  for (const result of results) {
    const countCell = result.error ? ' ERR' : String(result.count).padStart(4);
    const desc = result.testCase.label.slice(0, 52);
    console.log(`  ${result.testCase.id.padEnd(4)}  ${countCell}  ${desc}`);
  }

  console.log('');

  // ── Diagnosis ───────────────────────────────────────────────────────────────

  printDiagnosis(results, searchTerms, pageId);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('\n❌ Diagnostic failed:', redactToken(message));
  process.exit(1);
});
