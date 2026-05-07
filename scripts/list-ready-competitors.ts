/**
 * Phase 5 Step 1 — Meta-ready competitor readiness audit
 *
 * Read-only CLI. No DB writes. No Meta API calls. No token required.
 *
 * Usage:
 *   npm run meta:ready
 *
 * Optional:
 *   META_READY_STALE_DAYS=14 npm run meta:ready
 */

import { db } from '@/lib/db';
import { getMetaReadyCompetitors, type MetaReadyCompetitor } from '@/lib/queries/competitors';

function formatDate(date: Date | null): string {
  if (!date) return 'Never';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function daysSince(date: Date | null): number | null {
  if (!date) return null;
  const diffMs = Date.now() - date.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function parseStaleDays(): number {
  const raw = process.env.META_READY_STALE_DAYS;
  if (!raw) return 7;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 7;
  return parsed;
}

function getReadinessVerdict(competitor: MetaReadyCompetitor, staleDays: number): string {
  if (competitor.pendingMetaAdCount > 0) {
    return 'NEEDS REVIEW — pending ads exist';
  }

  if (!competitor.lastScannedAt) {
    return 'READY — never scanned';
  }

  const age = daysSince(competitor.lastScannedAt);
  if (age !== null && age >= staleDays) {
    return `READY — stale (${age} days since last scan)`;
  }

  return 'READY — scanned before';
}

function formatLatestScan(competitor: MetaReadyCompetitor): string {
  if (!competitor.latestScanRun) return 'None';

  const scan = competitor.latestScanRun;
  return `${scan.status} — ${scan.newAdsFound} new, ${scan.adsUnchanged} seen, started ${formatDate(scan.startedAt)}`;
}

function printCompetitor(competitor: MetaReadyCompetitor, index: number, total: number, staleDays: number): void {
  const pendingSuffix = competitor.pendingMetaAdCount > 0 ? '  ⚠  review queue has items' : '';

  console.log(`\n[${index}/${total}] ${competitor.name}`);
  console.log(`  COMPETITOR_ID:   ${competitor.id}`);
  console.log(`  Meta Page ID:    ${competitor.metaPageId}`);
  console.log(`  Facebook URL:    ${competitor.facebookPageUrl ?? 'Not set'}`);
  console.log(`  Client:          ${competitor.client?.name ?? 'Not set'}`);
  console.log(`  Industry:        ${competitor.industry?.name ?? 'Not set'}`);
  console.log(`  Last scanned:    ${formatDate(competitor.lastScannedAt)}`);
  console.log(`  Latest scan:     ${formatLatestScan(competitor)}`);
  console.log(`  Total Meta ads:  ${competitor.totalMetaAdCount}`);
  console.log(`  Pending review:  ${competitor.pendingMetaAdCount}${pendingSuffix}`);
  console.log(`  Verdict:         ${getReadinessVerdict(competitor, staleDays)}`);
  console.log(
    `  Dry-run:         COMPETITOR_ID=${competitor.id} META_ADLIB_TOKEN=<token> META_DRY_RUN=true META_SEARCH_TERMS='' META_FETCH_LIMIT=25 npm run meta:ingest`,
  );
}

function printSummary(competitors: MetaReadyCompetitor[], staleDays: number): void {
  const neverScanned = competitors.filter((competitor) => !competitor.lastScannedAt).length;
  const stale = competitors.filter((competitor) => {
    const age = daysSince(competitor.lastScannedAt);
    return age !== null && age >= staleDays;
  }).length;
  const pending = competitors.filter((competitor) => competitor.pendingMetaAdCount > 0).length;

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total ready:     ${competitors.length}`);
  console.log(`  Never scanned:   ${neverScanned}`);
  console.log(`  Stale:           ${stale}`);
  console.log(`  Pending review:  ${pending} competitor(s) have pending ads`);
  console.log('═══════════════════════════════════════════════════════════════');
}

async function main(): Promise<void> {
  const staleDays = parseStaleDays();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Phase 5 Step 1 — Meta Ingestion Readiness Audit');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Stale threshold: ${staleDays} days (set META_READY_STALE_DAYS to change)`);
  console.log('  Read-only:       no DB writes, no Meta API calls, no token required.');

  const competitors = await getMetaReadyCompetitors();

  if (competitors.length === 0) {
    console.log('\nNo competitors are ready for Meta ingestion.');
    console.log('Add a Meta Page ID on a competitor detail page first.');
    process.exitCode = 1;
    return;
  }

  competitors.forEach((competitor, index) => {
    printCompetitor(competitor, index + 1, competitors.length, staleDays);
  });

  printSummary(competitors, staleDays);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\n❌ Readiness audit failed:', message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
