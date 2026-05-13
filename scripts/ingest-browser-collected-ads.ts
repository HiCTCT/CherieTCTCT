/**
 * Browser-Collected Ads — Dry-Run Ingestion Script
 *
 * Reads a browser-collected ads CSV, scores each READY row using analyseAdRow(),
 * checks for existing duplicate metaAdIds in the database, and prints exactly
 * what would be written to the Ad and AdAnalysis tables.
 *
 * DEFAULT MODE: DRY RUN — no database writes are performed.
 * To enable live writes in the future, set BROWSER_DRY_RUN=false explicitly.
 *
 * Usage:
 *   npm run browser:ingest
 *
 * Override input file:
 *   set BROWSER_ADS_FILE=data/imports/my-file.csv&& npm run browser:ingest
 *
 * Override competitor (required if multiple competitors share the same metaPageId):
 *   set COMPETITOR_ID=cmp23o62c000p2fn63ut08wrn&& npm run browser:ingest
 *
 * Enable future live write mode (NOT YET ACTIVE — dry-run logic only):
 *   set BROWSER_DRY_RUN=false&& npm run browser:ingest
 *
 * Environment variables:
 *   BROWSER_ADS_FILE   — CSV path (default: data/imports/castlery-browser-collected-ads-pilot-01.csv)
 *   BROWSER_DRY_RUN    — 'false' to enable future live writes; anything else = dry-run (default: true)
 *   COMPETITOR_ID      — Prisma cuid of target Competitor; optional if metaPageId is unique in DB
 */

import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

import { analyseAdRow } from '@/lib/analysis';
import type { AdFormat, AnalysisOutput, ExampleRow } from '@/lib/analysis/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_FILE    = 'data/imports/castlery-browser-collected-ads-pilot-01.csv';
const SCORE_THRESHOLD = 7.0;
const AD_SOURCE       = 'browser_collected';

const EXPECTED_HEADER = [
  'collection_status',
  'competitor_name',
  'meta_page_id',
  'ad_id',
  'ad_library_url',
  'media_type',
  'publisher_platforms',
  'ad_delivery_start_time',
  'ad_copy',
  'headline',
  'description',
  'landing_page_url',
  'notes',
  'visual_description',
  'creative_notes',
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type BrowserAdRow = {
  collection_status: string;
  competitor_name: string;
  meta_page_id: string;
  ad_id: string;
  ad_library_url: string;
  media_type: string;
  publisher_platforms: string;
  ad_delivery_start_time: string;
  ad_copy: string;
  headline: string;
  description: string;
  landing_page_url: string;
  notes: string;
  visual_description: string;
  creative_notes: string;
};

type CompetitorRecord = {
  id: string;
  name: string;
  clientId: string;
  industryId: string;
  metaPageId: string | null;
  status: string;
};

type FormatDerivation =
  | { ok: true;  format: AdFormat }
  | { ok: false; reason: string  };

type RowOutcome = 'WOULD_INSERT' | 'INSERTED' | 'SKIPPED_EXISTING' | 'SKIPPED_DUPLICATE' | 'WRITE_ERROR' | 'SKIPPED_ERROR';

type ProcessedRow = {
  rowNumber: number;
  adId: string;
  mediaType: string;
  format: AdFormat;
  analysis: AnalysisOutput;
  outcome: RowOutcome;
  activeSince: Date | null;
  row: BrowserAdRow;
};

type ErroredRow = {
  rowNumber: number;
  adId: string;
  mediaType: string;
  outcome: 'SKIPPED_ERROR';
  error: string;
};

type RowResult = ProcessedRow | ErroredRow;

function isErrored(r: RowResult): r is ErroredRow {
  return r.outcome === 'SKIPPED_ERROR';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(str: string | undefined | null, max: number): string {
  if (!str) return '(empty)';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'N/A';
  return n.toFixed(1);
}

function deriveFormat(mediaType: string): FormatDerivation {
  const mt = mediaType.trim().toUpperCase();
  if (mt === 'IMAGE' || mt === 'CAROUSEL') return { ok: true, format: 'STATIC' };
  if (mt === 'VIDEO')                       return { ok: true, format: 'VIDEO'  };
  return {
    ok: false,
    reason: `media_type="${mediaType}" is not IMAGE, CAROUSEL, or VIDEO — cannot derive format`,
  };
}

function parseActiveSince(dateStr: string): Date | null {
  if (!dateStr || !dateStr.trim()) return null;
  const d = new Date(dateStr.trim());
  return isNaN(d.getTime()) ? null : d;
}

// ─── ExampleRow mapping ───────────────────────────────────────────────────────
//
// Identical mapping to preview-browser-collected-ads.ts toExampleRow().
// visual_description → Creative Analysis (creativeAnalysisText in scorer)
// creative_notes     → Analysis          (analysisNotes in scorer)

function toExampleRow(row: BrowserAdRow): ExampleRow {
  return {
    Product:             row.competitor_name.trim() || 'Unknown Advertiser',
    'Ad Link':           row.ad_library_url.trim()  || undefined,
    Copy:                row.ad_copy.trim()          || undefined,
    Headline:            row.headline.trim()         || undefined,
    Description:         row.description.trim()      || undefined,
    'Active Since':      row.ad_delivery_start_time.trim() || undefined,
    Analysis:            row.creative_notes?.trim()        || undefined,
    'Creative Analysis': row.visual_description?.trim()    || undefined,
    Improvement:              undefined,
    'Creative Improvements':  undefined,
    'Other Feedbacks':        undefined,
  };
}

// ─── Competitor lookup ────────────────────────────────────────────────────────

async function resolveCompetitor(
  prisma: PrismaClient,
  metaPageId: string,
): Promise<CompetitorRecord> {
  const explicitId = process.env.COMPETITOR_ID?.trim();

  if (explicitId) {
    const competitor = await prisma.competitor.findUnique({
      where: { id: explicitId },
      select: { id: true, name: true, clientId: true, industryId: true, metaPageId: true, status: true },
    });

    if (!competitor) {
      throw new Error(
        `COMPETITOR_ID="${explicitId}" was not found in the database.\n` +
        'Check that the id is correct and that the competitor has been imported.',
      );
    }

    console.log(`  Competitor:    ${competitor.name} (${competitor.id})  [resolved via COMPETITOR_ID]`);
    return competitor;
  }

  // Auto-detect by metaPageId
  const matches = await prisma.competitor.findMany({
    where: { metaPageId },
    select: { id: true, name: true, clientId: true, industryId: true, metaPageId: true, status: true },
  });

  if (matches.length === 0) {
    throw new Error(
      `No competitor found with metaPageId "${metaPageId}".\n` +
      'Has import:clients been run? Or set COMPETITOR_ID to the correct competitor cuid.',
    );
  }

  if (matches.length > 1) {
    const list = matches
      .map((m) => `  • id: ${m.id}  name: ${m.name}  clientId: ${m.clientId}`)
      .join('\n');
    throw new Error(
      `Multiple competitors share metaPageId "${metaPageId}":\n${list}\n\n` +
      'Set COMPETITOR_ID=<id> to specify which competitor to use.',
    );
  }

  const competitor = matches[0]!;
  console.log(`  Competitor:    ${competitor.name} (${competitor.id})  [auto-detected via metaPageId]`);
  return competitor;
}

// ─── Dry-run output per row ───────────────────────────────────────────────────

function printDryRunRow(
  r: ProcessedRow,
  competitor: CompetitorRecord,
  DIV: string,
): void {
  const { rowNumber, adId, mediaType, format, analysis, outcome, activeSince, row } = r;
  const outcomeIcon = outcome === 'WOULD_INSERT' ? '✓' : '○';
  const outcomeLabel = outcome === 'WOULD_INSERT'
    ? '[WOULD INSERT]'
    : '[SKIPPED — duplicate metaAdId already in DB]';

  console.log(`\n  ${outcomeIcon} Row ${rowNumber}  ad_id=${adId}  ${outcomeLabel}`);
  console.log(`  ${DIV}`);

  console.log('  Ad record:');
  console.log(`    competitorId:    ${competitor.id}`);
  console.log(`    clientId:        ${competitor.clientId}`);
  console.log(`    industryId:      ${competitor.industryId}`);
  console.log(`    metaAdId:        ${adId}`);
  console.log(`    adSource:        ${AD_SOURCE}`);
  console.log(`    adFormat:        ${format}`);
  console.log(`    score:           ${analysis.overallScore.toFixed(2)}`);
  console.log(`    qualified:       ${analysis.qualified}`);
  console.log(`    reviewStatus:    PENDING`);
  console.log(`    adStatus:        ACTIVE`);
  console.log(`    activeSince:     ${activeSince ? activeSince.toISOString().slice(0, 10) : '(empty)'}`);
  console.log(`    primaryCopy:     ${truncate(row.ad_copy, 80)}`);
  console.log(`    headline:        ${truncate(row.headline, 80)}`);
  console.log(`    description:     ${truncate(row.description, 80)}`);
  console.log(`    adLink:          ${truncate(row.ad_library_url, 80)}`);
  console.log(`    productOrService:${row.competitor_name.trim() || '(empty)'}`);

  console.log('');
  console.log('  AdAnalysis record:');
  console.log(`    overallScore:        ${analysis.overallScore.toFixed(2)}`);
  console.log(`    finalVerdict:        ${analysis.finalVerdict}`);
  console.log(`    funnelStage:         ${analysis.funnelStage}`);
  console.log(`    raceStage:           ${analysis.raceStage}`);
  console.log(`    trustFunnelStage:    ${analysis.trustFunnelStage}`);
  console.log(`    copyScore:           ${fmt(analysis.copyScore)}`);
  console.log(`    headlineScore:       ${fmt(analysis.headlineScore)}`);
  console.log(`    descriptionScore:    ${fmt(analysis.descriptionScore)}`);
  console.log(`    creativeScore:       ${fmt(analysis.creativeScore)}`);
  console.log(`    clarityScore:        ${fmt(analysis.clarityScore)}`);
  console.log(`    connectionScore:     ${fmt(analysis.connectionScore)}`);
  console.log(`    convictionScore:     ${fmt(analysis.convictionScore)}`);
  console.log(`    aidaAttention:       ${analysis.aidaScores.attention.toFixed(1)}`);
  console.log(`    aidaInterest:        ${analysis.aidaScores.interest.toFixed(1)}`);
  console.log(`    aidaDesire:          ${analysis.aidaScores.desire.toFixed(1)}`);
  console.log(`    aidaAction:          ${analysis.aidaScores.action.toFixed(1)}`);

  const activeTriggers = analysis.behaviouralTriggers.filter((t) => t.strength !== 'MISSING');
  if (activeTriggers.length > 0) {
    const triggerStr = activeTriggers.map((t) => `${t.name}(${t.strength})`).join(', ');
    console.log(`    behaviouralTriggers: ${triggerStr}`);
  } else {
    console.log(`    behaviouralTriggers: none detected`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const LINE = '═'.repeat(63);
  const DIV  = '─'.repeat(63);

  // ── Mode and file resolution ─────────────────────────────────────────────────
  const dryRun      = process.env.BROWSER_DRY_RUN !== 'false';
  const writeFlag   = process.env.BROWSER_INGEST_WRITE === 'true';
  const confirmFlag = process.env.BROWSER_INGEST_CONFIRM_DB_WRITES;
  const liveWrite   = !dryRun && writeFlag && confirmFlag === 'I_UNDERSTAND';
  const filePath    = path.resolve(process.env.BROWSER_ADS_FILE ?? DEFAULT_FILE);

  console.log(`\n${LINE}`);
  console.log('  Browser-Collected Ads — Ingestion');
  console.log(LINE);
  if (dryRun) {
    console.log('  Mode:          DRY RUN — no DB writes');
    console.log(`  File:          ${filePath}`);
    console.log(`  Score threshold: ${SCORE_THRESHOLD.toFixed(1)}`);
    console.log(`  adSource:      ${AD_SOURCE}`);
    console.log('  DB writes:     0');
    console.log('  To enable live writes, set all 3 flags:');
    console.log('    BROWSER_DRY_RUN=false');
    console.log('    BROWSER_INGEST_WRITE=true');
    console.log('    BROWSER_INGEST_CONFIRM_DB_WRITES=I_UNDERSTAND');
  } else {
    console.log('  Mode:          ⚠  LIVE WRITE MODE — DB writes are ACTIVE');
    console.log(`  File:          ${filePath}`);
    console.log(`  Score threshold: ${SCORE_THRESHOLD.toFixed(1)}`);
    console.log(`  adSource:      ${AD_SOURCE}`);
  }
  console.log(LINE);

  // ── Guard: all 3 flags required for live write ────────────────────────────────
  if (!dryRun && !liveWrite) {
    console.error('\n❌ Live write mode requires all 3 flags to be set correctly:');
    console.error(`   BROWSER_DRY_RUN=false                         ${!dryRun ? '✓' : '✗ not set'}`);
    console.error(`   BROWSER_INGEST_WRITE=true                     ${writeFlag ? '✓' : '✗ missing or wrong'}`);
    console.error(`   BROWSER_INGEST_CONFIRM_DB_WRITES=I_UNDERSTAND  ${confirmFlag === 'I_UNDERSTAND' ? '✓' : '✗ missing or wrong'}`);
    console.error('\n   Re-run with all 3 flags set, or remove BROWSER_DRY_RUN=false to stay in dry-run.');
    process.exit(1);
  }

  // ── Read and parse CSV ───────────────────────────────────────────────────────
  if (!fs.existsSync(filePath)) {
    console.error(`\n❌ File not found: ${filePath}`);
    console.error('   Set BROWSER_ADS_FILE to override the default path.');
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const rawRows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  if (rawRows.length === 0) {
    console.error('\n❌ CSV has no data rows.');
    process.exit(1);
  }

  // ── Validate header ──────────────────────────────────────────────────────────
  const actualCols  = Object.keys(rawRows[0]!);
  const missingCols = EXPECTED_HEADER.filter((c) => !actualCols.includes(c));

  if (missingCols.length > 0) {
    console.error(`\n❌ Missing required columns: ${missingCols.join(', ')}`);
    process.exit(1);
  }

  // ── Bucket rows by status ────────────────────────────────────────────────────
  let needsReviewCount = 0;
  let skipCount        = 0;
  let otherCount       = 0;
  const readyRows: Array<{ row: BrowserAdRow; rowNumber: number }> = [];

  rawRows.forEach((raw, idx) => {
    const row    = raw as unknown as BrowserAdRow;
    const status = (row.collection_status ?? '').trim().toUpperCase();
    const rowNum = idx + 2;

    if      (status === 'READY')        readyRows.push({ row, rowNumber: rowNum });
    else if (status === 'NEEDS_REVIEW') needsReviewCount++;
    else if (status === 'SKIP')         skipCount++;
    else                                otherCount++;
  });

  console.log(`\n${DIV}`);
  console.log('  Input Summary');
  console.log(DIV);
  console.log(`  Total rows:             ${rawRows.length}`);
  console.log(`  READY (will process):   ${readyRows.length}`);
  console.log(`  NEEDS_REVIEW (skipped): ${needsReviewCount}`);
  console.log(`  SKIP (skipped):         ${skipCount}`);
  if (otherCount > 0) console.log(`  Other/unknown (skipped):${otherCount}`);

  if (readyRows.length === 0) {
    console.log('\n  ⚠  No READY rows found. Nothing to process.');
    printSafetyFooter(LINE, dryRun);
    return;
  }

  // ── Resolve competitor ───────────────────────────────────────────────────────
  // Use meta_page_id from the first READY row as the lookup key.
  // All rows in a single browser-collected CSV should belong to the same competitor.
  const firstMetaPageId = readyRows[0]!.row.meta_page_id.trim();
  const prisma = new PrismaClient();

  let competitor: CompetitorRecord;

  try {
    console.log(`\n${DIV}`);
    console.log('  Competitor Resolution');
    console.log(DIV);
    competitor = await resolveCompetitor(prisma, firstMetaPageId);
    console.log(`  clientId:      ${competitor.clientId}`);
    console.log(`  industryId:    ${competitor.industryId}`);
    console.log(`  status:        ${competitor.status}`);
    console.log(`  metaPageId:    ${competitor.metaPageId ?? '(not set)'}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Competitor lookup failed:\n   ${message}`);
    await prisma.$disconnect();
    process.exit(1);
  }

  // ── Score all READY rows ─────────────────────────────────────────────────────
  type ScoredRow = {
    rowNumber: number;
    adId: string;
    mediaType: string;
    format: AdFormat;
    analysis: AnalysisOutput;
    activeSince: Date | null;
    row: BrowserAdRow;
  };

  type PreErrorRow = {
    rowNumber: number;
    adId: string;
    mediaType: string;
    error: string;
  };

  const scored: ScoredRow[]    = [];
  const preErrors: PreErrorRow[] = [];
  let staticCount = 0;
  let videoCount  = 0;

  for (const { row, rowNumber } of readyRows) {
    const adId = row.ad_id.trim() || `(row ${rowNumber})`;

    const derived = deriveFormat(row.media_type);
    if (!derived.ok) {
      preErrors.push({ rowNumber, adId, mediaType: row.media_type, error: derived.reason });
      continue;
    }

    const format = derived.format;
    if (format === 'STATIC') staticCount++;
    else                     videoCount++;

    try {
      const exampleRow = toExampleRow(row);
      const analysis   = analyseAdRow(exampleRow, format);
      scored.push({
        rowNumber,
        adId,
        mediaType: row.media_type.trim().toUpperCase(),
        format,
        analysis,
        activeSince: parseActiveSince(row.ad_delivery_start_time),
        row,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      preErrors.push({ rowNumber, adId, mediaType: row.media_type, error: `Scoring threw: ${message}` });
    }
  }

  // ── Deduplication check (DB read — dry-run safe) ─────────────────────────────
  const metaAdIds = scored.map((s) => s.adId).filter((id) => !/^\(row \d+\)$/.test(id));

  let existingSet = new Set<string>();
  if (metaAdIds.length > 0) {
    try {
      const existing = await prisma.ad.findMany({
        where: {
          competitorId: competitor.id,
          metaAdId: { in: metaAdIds },
        },
        select: { metaAdId: true },
      });
      existingSet = new Set(existing.map((a) => a.metaAdId!).filter(Boolean));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`\n  ⚠  Deduplication check failed (non-fatal in dry-run): ${message}`);
      console.warn('      All rows will be shown as WOULD_INSERT.');
    }
  }

  // ── Build final results ──────────────────────────────────────────────────────
  const results: RowResult[] = [];

  for (const s of scored) {
    const isDuplicate = existingSet.has(s.adId);
    results.push({
      ...s,
      outcome: isDuplicate ? 'SKIPPED_EXISTING' : 'WOULD_INSERT',
    });
  }

  for (const e of preErrors) {
    results.push({ ...e, outcome: 'SKIPPED_ERROR' });
  }

  // Sort by rowNumber for consistent output
  results.sort((a, b) => a.rowNumber - b.rowNumber);

  // ── Format breakdown ─────────────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log('  Format Breakdown (READY rows)');
  console.log(DIV);
  console.log(`  STATIC (IMAGE + CAROUSEL): ${staticCount}`);
  console.log(`  VIDEO:                     ${videoCount}`);
  if (preErrors.length > 0) {
    console.log(`  Errored (format/scoring):  ${preErrors.length}`);
  }

  // ── Per-row dry-run detail ───────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  Per-Row Ingestion Plan');
  console.log(LINE);

  for (const result of results) {
    if (isErrored(result)) {
      console.log(`\n  ✗ Row ${result.rowNumber}  ad_id=${result.adId}  [SKIPPED — ERROR]`);
      console.log(`    media_type: ${result.mediaType}`);
      console.log(`    ❌ ${result.error}`);
      continue;
    }

    printDryRunRow(result, competitor, DIV);
  }

  // ── Live write ───────────────────────────────────────────────────────────────
  let insertedCount = 0;
  let dupSkipCount  = 0;
  let writeErrCount = 0;

  if (liveWrite) {
    const toWrite = results.filter(
      (r): r is ProcessedRow => !isErrored(r) && r.outcome === 'WOULD_INSERT',
    );
    const preDetectedDups = results.filter(
      (r): r is ProcessedRow => !isErrored(r) && r.outcome === 'SKIPPED_EXISTING',
    ).length;

    console.log(`\n${LINE}`);
    console.log('  ⚠  LIVE WRITE MODE ACTIVE');
    console.log(LINE);
    console.log('  DB writes are enabled.');
    console.log('  No updates or deletes will be performed.');
    console.log('  Only new Ad + AdAnalysis records will be inserted.');
    console.log('');
    console.log(`  Rows eligible for insert:   ${toWrite.length}`);
    console.log(`  Duplicate rows (pre-check): ${preDetectedDups}`);
    console.log(`  Pre-write errored rows:     ${preErrors.length}`);
    console.log(LINE);

    for (const r of toWrite) {
      const now = new Date();
      try {
        await prisma.$transaction(async (tx) => {
          const ad = await tx.ad.create({
            data: {
              competitorId:     competitor.id,
              clientId:         competitor.clientId,
              industryId:       competitor.industryId,
              productOrService: r.row.competitor_name.trim() || undefined,
              adFormat:         r.format,
              adLink:           r.row.ad_library_url.trim() || '',
              activeSince:      r.activeSince ?? undefined,
              primaryCopy:      r.row.ad_copy.trim()      || undefined,
              headline:         r.row.headline.trim()     || undefined,
              description:      r.row.description.trim()  || undefined,
              metaAdId:         r.adId,
              adSource:         AD_SOURCE,
              reviewStatus:     'PENDING',
              score:            r.analysis.overallScore,
              qualified:        r.analysis.qualified,
              firstSeenAt:      now,
              lastSeenAt:       now,
              adStatus:         'ACTIVE',
            },
          });

          await tx.adAnalysis.create({
            data: {
              adId:                    ad.id,
              creativeAnalysis:        r.analysis.creativeAnalysis,
              copyAnalysis:            r.analysis.copyAnalysis,
              headlineAnalysis:        r.analysis.headlineAnalysis,
              descriptionAnalysis:     r.analysis.descriptionAnalysis,
              overallScore:            r.analysis.overallScore,

              // Shared sub-scores
              hookStopScrollScore:     r.analysis.subScores.hookStopScroll,
              audienceRelevanceScore:  r.analysis.subScores.audienceRelevance,
              valueClarityScore:       r.analysis.subScores.valueClarity,
              trustProofStrengthScore: r.analysis.subScores.trustProofStrength,
              ctaClarityScore:         r.analysis.subScores.ctaClarity,

              // Static-specific sub-scores (undefined → null for video)
              visualHierarchyScore:       r.analysis.subScores.visualHierarchy,
              productClarityScore:        r.analysis.subScores.productClarity,
              offerClarityScore:          r.analysis.subScores.offerClarity,
              headlineStrengthScore:      r.analysis.subScores.headlineStrength,
              descriptionUsefulnessScore: r.analysis.subScores.descriptionUsefulness,
              ctaVisibilityScore:         r.analysis.subScores.ctaVisibility,
              trustSignalsScore:          r.analysis.subScores.trustSignals,

              // Video-specific sub-scores (undefined → null for static)
              firstThreeSecondsScore:  r.analysis.subScores.firstThreeSeconds,
              soundOffDesignScore:     r.analysis.subScores.soundOffDesign,
              soundOnEnhancementScore: r.analysis.subScores.soundOnEnhancement,
              onScreenTextScore:       r.analysis.subScores.onScreenText,
              storyFlowScore:          r.analysis.subScores.storyFlow,
              authenticityScore:       r.analysis.subScores.authenticity,
              platformNativeFeelScore: r.analysis.subScores.platformNativeFeel,

              // Framework mapping
              aidaJson:    JSON.stringify(r.analysis.aida),
              funnelStage: r.analysis.funnelStage,
              raceStage:   r.analysis.raceStage,

              strengthsJson:    JSON.stringify(r.analysis.strengths),
              weaknessesJson:   JSON.stringify(r.analysis.weaknesses),
              improvementsJson: JSON.stringify(r.analysis.improvements),
              rubricScoresJson: JSON.stringify(r.analysis.subScores),

              // Phase 3.5: Conversion-focused scoring fields
              copyScore:               r.analysis.copyScore,
              headlineScore:           r.analysis.headlineScore,
              descriptionScore:        r.analysis.descriptionScore,
              creativeScore:           r.analysis.creativeScore,
              aidaAttentionScore:      r.analysis.aidaScores.attention,
              aidaInterestScore:       r.analysis.aidaScores.interest,
              aidaDesireScore:         r.analysis.aidaScores.desire,
              aidaActionScore:         r.analysis.aidaScores.action,
              clarityScore:            r.analysis.clarityScore,
              connectionScore:         r.analysis.connectionScore,
              convictionScore:         r.analysis.convictionScore,
              trustFunnelStage:        r.analysis.trustFunnelStage,
              behaviouralTriggersJson: JSON.stringify(r.analysis.behaviouralTriggers),
              recommendationsJson:     JSON.stringify(r.analysis.recommendations),
              rewriteDirectionJson:    r.analysis.rewriteDirection
                ? JSON.stringify(r.analysis.rewriteDirection)
                : null,
              finalVerdict: r.analysis.finalVerdict,
            },
          });
        });

        r.outcome = 'INSERTED';
        insertedCount++;
        console.log(`  ✓ Inserted  row ${r.rowNumber}  ad_id=${r.adId}  score=${r.analysis.overallScore.toFixed(2)}  qualified=${r.analysis.qualified}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('unique constraint')) {
          r.outcome = 'SKIPPED_DUPLICATE';
          dupSkipCount++;
          console.log(`  ○ Skipped   row ${r.rowNumber}  ad_id=${r.adId}  [duplicate — metaAdId already in DB]`);
        } else {
          r.outcome = 'WRITE_ERROR';
          writeErrCount++;
          console.error(`  ✗ Error     row ${r.rowNumber}  ad_id=${r.adId}  ❌ ${msg}`);
        }
      }
    }

    // Add pre-detected duplicates to the total skip count
    dupSkipCount += preDetectedDups;

    console.log(`\n${LINE}`);
    console.log('  ✓ LIVE WRITE COMPLETE');
    console.log(LINE);
    console.log(`  Inserted:                ${insertedCount}`);
    console.log(`  Skipped (duplicate):     ${dupSkipCount}`);
    console.log(`  Errored:                 ${preErrors.length + writeErrCount}`);
    console.log('');
    console.log('  No existing records were updated or deleted.');
    console.log(LINE);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  // processedRows: all scored rows (includes duplicates, excludes pre-scoring errors).
  // Score stats are computed from ALL processedRows so duplicate-only runs still show
  // correct qualified / avg / distribution figures instead of "0 of 0 / N/A".
  const processedRows    = results.filter((r): r is ProcessedRow => !isErrored(r));
  const insertCandidates = processedRows.filter((r) =>
    liveWrite ? r.outcome === 'INSERTED' : r.outcome === 'WOULD_INSERT',
  );
  const skipCandidates = processedRows.filter((r) =>
    liveWrite
      ? r.outcome === 'SKIPPED_EXISTING' || r.outcome === 'SKIPPED_DUPLICATE'
      : r.outcome === 'SKIPPED_EXISTING',
  );

  // Score stats: always from ALL processedRows regardless of duplicate status
  const qualifiedAll   = processedRows.filter((r) => r.analysis.qualified);
  const unqualifiedAll = processedRows.filter((r) => !r.analysis.qualified);
  const avgScore       = processedRows.length > 0
    ? processedRows.reduce((sum, r) => sum + r.analysis.overallScore, 0) / processedRows.length
    : null;
  const totalErrored   = preErrors.length + (liveWrite ? writeErrCount : 0);

  // Qualify counts scoped to insert-only (used in verdict messaging)
  const qualifiedInserted   = insertCandidates.filter((r) => r.analysis.qualified);
  const unqualifiedInserted = insertCandidates.filter((r) => !r.analysis.qualified);

  console.log(`\n${LINE}`);
  console.log(`  ${liveWrite ? 'WRITE SUMMARY' : 'SUMMARY'}`);
  console.log(LINE);

  // ── READY row analysis (all scored rows, regardless of duplicate status) ──────
  console.log(`  READY rows analysed:              ${readyRows.length}`);
  console.log(`  Successfully scored:              ${processedRows.length}`);
  console.log(`  Qualified among READY rows:       ${qualifiedAll.length} of ${processedRows.length}`);
  console.log(`  Non-qualified among READY rows:   ${unqualifiedAll.length} of ${processedRows.length}`);
  console.log(`  Average score among READY rows:   ${avgScore !== null ? avgScore.toFixed(2) : 'N/A'}`);
  if (totalErrored > 0) {
    console.log(`  Errored (skipped):               ${totalErrored}`);
  }
  console.log('');

  // ── Ingestion action summary ──────────────────────────────────────────────────
  if (liveWrite) {
    console.log(`  Inserted:                        ${insertedCount}`);
    console.log(`  Skipped (duplicate):             ${dupSkipCount}`);
  } else {
    console.log(`  Would INSERT:                    ${insertCandidates.length}`);
    console.log(`  Would SKIP duplicate:            ${skipCandidates.length}`);
  }

  console.log('');
  console.log('  Score distribution (all READY rows):');

  const band = (lo: number, hi: number) =>
    processedRows.filter((r) => r.analysis.overallScore >= lo && r.analysis.overallScore < hi).length;

  console.log(`    ≥ 9.0       :  ${processedRows.filter((r) => r.analysis.overallScore >= 9.0).length}`);
  console.log(`    7.0 – 8.9   :  ${band(7.0, 9.0)}`);
  console.log(`    5.0 – 6.9   :  ${band(5.0, 7.0)}`);
  console.log(`    below 5.0   :  ${processedRows.filter((r) => r.analysis.overallScore < 5.0).length}`);

  // ── Verdict ───────────────────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log(`  ${liveWrite ? 'POST-WRITE CONFIRMATION' : 'DRY RUN VERDICT'}`);
  console.log(LINE);

  if (liveWrite) {
    console.log(`\n  ✓ Live write complete.`);
    console.log(`    Inserted:  ${insertedCount} Ad + AdAnalysis record(s).`);
    console.log(`    Skipped:   ${dupSkipCount} duplicate(s) — competitorId + metaAdId already in DB.`);
    if (writeErrCount > 0) {
      console.log(`    Errors:    ${writeErrCount} row(s) failed — review errors above.`);
    }
    console.log('');
    console.log('    No existing records were updated or deleted.');
    console.log(`    adSource='${AD_SOURCE}' stored on all inserted ads.`);
    console.log(`    qualified=true: ${qualifiedInserted.length}  |  qualified=false: ${unqualifiedInserted.length}`);
    console.log('    Winning-ad views can filter qualified=true at query time.');
  } else if (preErrors.length === 0) {
    console.log(`\n  ✓ READY — ${insertCandidates.length} row(s) can be ingested with 0 scoring errors.`);
    if (insertCandidates.length > 0) {
      console.log(`    All ${insertCandidates.length} would be stored as adSource='${AD_SOURCE}'.`);
      console.log(`    qualified=true:  ${qualifiedInserted.length}  |  qualified=false: ${unqualifiedInserted.length}`);
      console.log('    Non-qualified ads are stored as competitor reference data.');
      console.log('    Winning-ad views can filter qualified=true at query time.');
    }
    if (skipCandidates.length > 0) {
      console.log(`    ${skipCandidates.length} duplicate(s) would be skipped (competitorId + metaAdId already in DB).`);
    }
    console.log('');
    console.log('  Next steps before live write:');
    console.log('  1. Back up the database:');
    console.log('       copy prisma\\dev.db prisma\\dev.db.backup-pre-browser-ingestion');
    console.log('  2. Re-run with all 3 flags:');
    console.log('       BROWSER_DRY_RUN=false');
    console.log('       BROWSER_INGEST_WRITE=true');
    console.log('       BROWSER_INGEST_CONFIRM_DB_WRITES=I_UNDERSTAND');
  } else {
    console.log(`\n  ⚠  ${preErrors.length} row(s) errored and would be skipped.`);
    console.log('    Review errors above before proceeding to live ingestion.');
  }

  console.log('');
  printSafetyFooter(LINE, dryRun);

  await prisma.$disconnect();
}

function printSafetyFooter(LINE: string, dryRun: boolean): void {
  console.log(LINE);
  console.log('  Safety confirmation');
  console.log(LINE);
  if (dryRun) {
    console.log('  No database writes were performed.');
    console.log('  No records were inserted, updated, or deleted.');
  } else {
    console.log('  No existing records were updated or deleted.');
    console.log('  Only new Ad + AdAnalysis records were inserted (if any).');
  }
  console.log('  No scoring changes were made.');
  console.log('  No schema changes were made.');
  console.log('  data/imports/*.csv remains uncommitted by design.');
  console.log(LINE);
  console.log('');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('\n❌ Fatal error:', message);
  process.exit(1);
});
