/**
 * Browser-Collected Ads — Dry-Run Scoring Preview
 *
 * Reads a browser-collected ads CSV, filters to READY rows, maps each row
 * into the ExampleRow shape expected by analyseAdRow(), runs the existing
 * scoring function unchanged, and prints a full scoring report.
 *
 * DRY RUN ONLY — no database writes, no ingestion, no scoring changes.
 *
 * Usage:
 *   npm run browser:preview
 *
 * Override input file:
 *   set BROWSER_ADS_FILE=data/imports/my-file.csv&& npm run browser:preview
 */

import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';

import { analyseAdRow } from '@/lib/analysis';
import type { AdFormat, AnalysisOutput, ExampleRow } from '@/lib/analysis/types';
import { resolveCreativeContext } from '@/lib/analysis/creativeAssetAnalyser';
import type { CreativeContext, CreativeSource } from '@/lib/analysis/creativeAssetAnalyser';
import { scoreCompetitorBenchmarkAd } from '@/lib/analysis/competitorScoring';
import type { CompetitorBenchmark } from '@/lib/analysis/competitorScoring';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_FILE = 'data/imports/castlery-browser-collected-ads-pilot-01.csv';
const SCORE_THRESHOLD = 7.0;

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
  // Optional analyst-context columns (added Phase 7.5)
  visual_description: string;
  creative_notes: string;
  // Optional creative asset column (Phase 8 — vision analysis)
  creative_asset_path?: string;
};

type ScoredRow = {
  rowNumber: number;
  adId: string;
  mediaType: string;
  format: AdFormat;
  analysis: AnalysisOutput;
  copyPreview: string;
  visualDescPreview: string;
  creativeNotesPreview: string;
  // Debug fields — exact values passed into analyseAdRow()
  exampleRowAnalysis: string;
  exampleRowCreativeAnalysis: string;
  exampleRowCopy: string;
  exampleRowHeadline: string;
  exampleRowDescription: string;
  copyWasContaminated: boolean;
  rawAdCopy: string;
  creativeSource: CreativeSource;
  benchmark: CompetitorBenchmark;
  error: null;
};

type ErroredRow = {
  rowNumber: number;
  adId: string;
  mediaType: string;
  error: string;
};

type RowResult = ScoredRow | ErroredRow;

function isErrored(r: RowResult): r is ErroredRow {
  return r.error !== null;
}

// ─── Copy cleaning ────────────────────────────────────────────────────────────

/**
 * Detects comment-contaminated ad_copy (e.g. UGC comment dumps captured by the browser).
 * Conservative patterns only — false negatives are preferred over false positives.
 *
 * Flags as contaminated when:
 *  1. Copy starts with a separator character: ; | ,
 *  2. Copy contains 3+ semicolon-separated segments that are all short (avg < 120 chars)
 *
 * Returns cleanedCopy (undefined if entire content is contaminated) and a wasContaminated flag.
 */
function cleanAdCopy(raw: string): { cleanedCopy: string | undefined; wasContaminated: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { cleanedCopy: undefined, wasContaminated: false };

  // Pattern 1: leading separator character (; | ,)
  if (/^[;|,]/.test(trimmed)) {
    return { cleanedCopy: undefined, wasContaminated: true };
  }

  // Pattern 2: multiple semicolons with short segments — UGC comment concatenation
  const parts = trimmed.split(';');
  if (parts.length >= 3) {
    const avgLen =
      parts.map((p) => p.trim().length).reduce((a, b) => a + b, 0) / parts.length;
    if (avgLen < 120) {
      return { cleanedCopy: undefined, wasContaminated: true };
    }
  }

  return { cleanedCopy: trimmed, wasContaminated: false };
}

// ─── Format derivation ────────────────────────────────────────────────────────

type FormatDerivation =
  | { ok: true;  format: AdFormat }
  | { ok: false; reason: string  };

function deriveFormat(mediaType: string): FormatDerivation {
  const mt = mediaType.trim().toUpperCase();
  if (mt === 'IMAGE' || mt === 'CAROUSEL') return { ok: true, format: 'STATIC' };
  if (mt === 'VIDEO')                       return { ok: true, format: 'VIDEO'  };
  return { ok: false, reason: `media_type="${mediaType}" is not IMAGE, CAROUSEL, or VIDEO — cannot derive format` };
}

// ─── ExampleRow mapping ───────────────────────────────────────────────────────
//
// Maps a browser-collected CSV row to the ExampleRow shape that analyseAdRow()
// expects. Mirrors the mapping in metaIngestion.ts normaliseRecord() without
// importing that DB-coupled module.

// creative context is resolved before this call (ASSET / MANUAL / FALLBACK).
// visual_description → 'Creative Analysis' → creativeAnalysisText in scorer
// creative_notes     → 'Analysis'          → analysisNotes in scorer
function toExampleRow(row: BrowserAdRow, creative: CreativeContext): ExampleRow {
  // Strip comment-contaminated ad_copy before passing to scorer.
  // cleanedCopy is undefined when the entire field is contaminated — scorer falls back to headline.
  const { cleanedCopy } = cleanAdCopy(row.ad_copy);
  return {
    Product:      row.competitor_name.trim() || 'Unknown Advertiser',
    'Ad Link':    row.ad_library_url.trim()  || undefined,
    Copy:         cleanedCopy                || undefined,
    Headline:     row.headline.trim()        || undefined,
    Description:  row.description.trim()     || undefined,
    'Active Since': row.ad_delivery_start_time.trim() || undefined,
    Analysis:            creative.creative_notes      || undefined,
    'Creative Analysis': creative.visual_description  || undefined,
    Improvement:              undefined,
    'Creative Improvements':  undefined,
    'Other Feedbacks':        undefined,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(str: string | undefined, max: number): string {
  if (!str) return '(empty)';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function scoreBar(score: number): string {
  const filled = Math.round(score);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${score.toFixed(1)}`;
}

function fmt(n: number | null): string {
  return n === null ? 'N/A (not provided)' : n.toFixed(1);
}

// ─── API key guard ────────────────────────────────────────────────────────────

/**
 * Aborts if any READY row has creative_asset_path set but ANTHROPIC_API_KEY
 * is absent. Called after bucketing rows, before any API call or DB access.
 */
function assertApiKeyIfAssets(
  readyRows: Array<{ row: BrowserAdRow; rowNumber: number }>,
): void {
  const rowsWithAssets = readyRows.filter(({ row }) => row.creative_asset_path?.trim());
  if (rowsWithAssets.length === 0) return;

  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    const rowNums = rowsWithAssets.map((r) => r.rowNumber).join(', ');
    console.error('\n❌ ANTHROPIC_API_KEY is required.');
    console.error(`   ${rowsWithAssets.length} READY row(s) have creative_asset_path set (row(s): ${rowNums}).`);
    console.error('   Set ANTHROPIC_API_KEY=<key> before re-running,');
    console.error('   or remove creative_asset_path from those rows to run without vision analysis.');
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const LINE = '═'.repeat(63);
  const DIV  = '─'.repeat(63);

  // ── Resolve file path ────────────────────────────────────────────────────────
  const filePath = path.resolve(process.env.BROWSER_ADS_FILE ?? DEFAULT_FILE);

  console.log(`\n${LINE}`);
  console.log('  Browser-Collected Ads — Scoring Preview');
  console.log(LINE);
  console.log(`  Mode:         DRY RUN — SCORING PREVIEW ONLY`);
  console.log(`  File:         ${filePath}`);
  console.log(`  Score threshold: ${SCORE_THRESHOLD.toFixed(1)}`);
  console.log(`  DB writes:    0`);
  console.log(`  Ingestion:    none`);
  console.log(LINE);

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
    const rowNum = idx + 2; // 1-based + header offset

    if      (status === 'READY')        readyRows.push({ row, rowNumber: rowNum });
    else if (status === 'NEEDS_REVIEW') needsReviewCount++;
    else if (status === 'SKIP')         skipCount++;
    else                                otherCount++;
  });

  console.log(`\n${DIV}`);
  console.log('  Input Summary');
  console.log(DIV);
  console.log(`  Total rows read:        ${rawRows.length}`);
  console.log(`  READY (will score):     ${readyRows.length}`);
  console.log(`  NEEDS_REVIEW (skipped): ${needsReviewCount}`);
  console.log(`  SKIP (skipped):         ${skipCount}`);
  if (otherCount > 0) console.log(`  Other/unknown (skipped):${otherCount}`);

  if (readyRows.length === 0) {
    console.log('\n  ⚠  No READY rows found. Nothing to score.');
    printSafetyFooter(LINE);
    return;
  }

  // ── API key guard ────────────────────────────────────────────────────────────
  assertApiKeyIfAssets(readyRows);

  // ── Score each READY row ─────────────────────────────────────────────────────
  const results: RowResult[] = [];
  let staticCount  = 0;
  let videoCount   = 0;
  let invalidCount = 0;

  for (const { row, rowNumber } of readyRows) {
    const adId = row.ad_id.trim() || `(row ${rowNumber})`;

    const derived = deriveFormat(row.media_type);
    if (!derived.ok) {
      invalidCount++;
      results.push({ rowNumber, adId, mediaType: row.media_type, error: derived.reason });
      continue;
    }

    const format = derived.format;
    if (format === 'STATIC') staticCount++;
    else                     videoCount++;

    try {
      // Resolve creative context: ASSET (vision API) → MANUAL (CSV text) → FALLBACK
      const creative = await resolveCreativeContext(row, row.media_type);

      const exampleRow = toExampleRow(row, creative);
      const analysis   = analyseAdRow(exampleRow, format);
      const benchmark  = scoreCompetitorBenchmarkAd(analysis, creative.source);
      const { wasContaminated: copyWasContaminated } = cleanAdCopy(row.ad_copy);
      results.push({
        rowNumber,
        adId,
        mediaType: row.media_type.trim().toUpperCase(),
        format,
        analysis,
        benchmark,
        copyPreview:          truncate(row.ad_copy.trim() || row.headline.trim(), 80),
        visualDescPreview:    truncate(creative.visual_description, 80),
        creativeNotesPreview: truncate(creative.creative_notes, 80),
        // Capture the exact ExampleRow values sent to the scorer for debugging
        exampleRowAnalysis:           exampleRow.Analysis              ?? '(empty)',
        exampleRowCreativeAnalysis:   exampleRow['Creative Analysis']  ?? '(empty)',
        exampleRowCopy:               exampleRow.Copy                  ?? '(empty)',
        exampleRowHeadline:           exampleRow.Headline              ?? '(empty)',
        exampleRowDescription:        exampleRow.Description           ?? '(empty)',
        copyWasContaminated,
        rawAdCopy:            row.ad_copy.trim(),
        creativeSource:       creative.source,
        error: null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ rowNumber, adId, mediaType: row.media_type, error: `Scoring threw: ${message}` });
      invalidCount++;
    }
  }

  const scored  = results.filter((r): r is ScoredRow  => !isErrored(r));
  const errored = results.filter((r): r is ErroredRow =>  isErrored(r));

  // ── Format breakdown ─────────────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log('  Format Breakdown');
  console.log(DIV);
  console.log(`  STATIC (IMAGE + CAROUSEL): ${staticCount}`);
  console.log(`  VIDEO:                     ${videoCount}`);
  if (invalidCount > 0) {
    console.log(`  Invalid / errored:         ${invalidCount}`);
  }

  // ── Per-row scoring detail ───────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  Per-Row Scoring Detail');
  console.log(LINE);

  for (const result of results) {
    if (isErrored(result)) {
      console.log(`\n  ✗ Row ${result.rowNumber}  ad_id=${result.adId}`);
      console.log(`    media_type: ${result.mediaType}`);
      console.log(`    ❌ ERROR: ${result.error}`);
      continue;
    }

    const {
      rowNumber, adId, mediaType, format, analysis,
      copyPreview, visualDescPreview, creativeNotesPreview,
      exampleRowAnalysis, exampleRowCreativeAnalysis,
      exampleRowCopy, exampleRowHeadline, exampleRowDescription,
      copyWasContaminated, rawAdCopy, creativeSource, benchmark,
    } = result;

    const sourceLabel =
      creativeSource === 'ASSET'    ? '[ASSET]    — vision analysis from creative_asset_path' :
      creativeSource === 'MANUAL'   ? '[MANUAL]   — from CSV visual_description / creative_notes' :
                                      '[FALLBACK] — machine-scored baseline (no asset or manual text)';
    const qualIcon = analysis.qualified ? '✓' : '○';

    console.log(`\n  ${qualIcon} Row ${rowNumber}  ad_id=${adId}`);
    console.log(`    media_type:     ${mediaType}  →  format: ${format}`);
    console.log(`    Creative source:${sourceLabel}`);
    if (copyWasContaminated) {
      console.log(`    ⚠  WARN [ad_copy]: comment-contaminated — excluded from scorer Copy field`);
      console.log(`    Raw copy:       ${truncate(rawAdCopy, 80)}`);
      console.log(`    Scorer Copy:    (empty — scorer will use Headline instead)`);
    } else {
      console.log(`    Copy preview:   ${copyPreview}`);
    }
    console.log(`    Visual desc:    ${visualDescPreview}`);
    console.log(`    Creative notes: ${creativeNotesPreview}`);
    console.log('');
    console.log('    ── [ExampleRow sent to analyseAdRow] ──────────────────');
    console.log(`      Analysis:          ${truncate(exampleRowAnalysis, 120)}`);
    console.log(`      Creative Analysis: ${truncate(exampleRowCreativeAnalysis, 120)}`);
    console.log(`      Copy:              ${truncate(exampleRowCopy, 120)}`);
    console.log(`      Headline:          ${truncate(exampleRowHeadline, 120)}`);
    console.log(`      Description:       ${truncate(exampleRowDescription, 120)}`);
    console.log('    ───────────────────────────────────────────────────────');
    console.log('');
    // ── Competitor benchmark (primary lens for competitor ads) ──
    const confIcon = benchmark.confidence === 'HIGH' ? '🟢' : benchmark.confidence === 'MEDIUM' ? '🟡' : '🔴';
    console.log('    ══ COMPETITOR BENCHMARK (primary for competitor ads) ══');
    console.log(`    Benchmark score:  ${scoreBar(benchmark.benchmarkScore)}`);
    console.log(`    Benchmark tier:   ${benchmark.tier}`);
    console.log(`    Confidence:       ${confIcon} ${benchmark.confidence}`);
    console.log(`    Evidence source:  ${benchmark.evidenceSource}`);
    console.log(`    Formula:          ${benchmark.formula}`);
    console.log(`    Inputs:           ${benchmark.breakdown.map((b) => `${b.label}=${b.value.toFixed(1)}×${b.weight}`).join('  ')}`);
    if (benchmark.warning) console.log(`    ⚠  ${benchmark.warning}`);
    console.log('');
    // ── Internal QA score (OOM internal scorer — shown for comparison only) ──
    console.log(`    Internal QA score: ${scoreBar(analysis.overallScore)}`);
    console.log(`    QA qualified:      ${analysis.qualified ? `YES ✓  (≥ ${SCORE_THRESHOLD})` : `NO    (below ${SCORE_THRESHOLD})`}   [internal QA gate — not the competitor decision]`);
    console.log(`    QA final verdict:  ${analysis.finalVerdict}`);
    console.log('');
    console.log('    Component scores:');
    console.log(`      Copy:         ${fmt(analysis.copyScore)}`);
    console.log(`      Headline:     ${fmt(analysis.headlineScore)}`);
    console.log(`      Description:  ${fmt(analysis.descriptionScore)}`);
    console.log(`      Creative:     ${fmt(analysis.creativeScore)}`);
    console.log(`      Clarity:      ${analysis.clarityScore.toFixed(1)}`);
    console.log(`      Connection:   ${analysis.connectionScore.toFixed(1)}`);
    console.log(`      Conviction:   ${analysis.convictionScore.toFixed(1)}`);
    console.log('');
    console.log('    AIDA scores:');
    console.log(`      Attention:    ${analysis.aidaScores.attention.toFixed(1)}`);
    console.log(`      Interest:     ${analysis.aidaScores.interest.toFixed(1)}`);
    console.log(`      Desire:       ${analysis.aidaScores.desire.toFixed(1)}`);
    console.log(`      Action:       ${analysis.aidaScores.action.toFixed(1)}`);
    console.log('');
    console.log(`    Funnel stage:  ${analysis.funnelStage}`);
    console.log(`    RACE stage:    ${analysis.raceStage}`);
    console.log(`    Trust funnel:  ${analysis.trustFunnelStage}`);

    const activeTriggers = analysis.behaviouralTriggers.filter(
      (t) => t.strength !== 'MISSING',
    );
    if (activeTriggers.length > 0) {
      const triggerStr = activeTriggers
        .map((t) => `${t.name} (${t.strength})`)
        .join(', ');
      console.log(`    Triggers:      ${triggerStr}`);
    } else {
      console.log('    Triggers:      none detected');
    }

    if (analysis.strengths.length > 0) {
      const top = analysis.strengths.slice(0, 2);
      console.log(`    Strengths:     ${top.join(' | ')}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const totalScored    = scored.length;
  const totalErrored   = errored.length;
  const qualifiedRows  = scored.filter((r) => r.analysis.qualified);
  const avgScore       = totalScored > 0
    ? scored.reduce((sum, r) => sum + r.analysis.overallScore, 0) / totalScored
    : 0;

  const band = (lo: number, hi: number) =>
    scored.filter((r) => r.analysis.overallScore >= lo && r.analysis.overallScore < hi).length;

  console.log(`\n${LINE}`);
  console.log('  INTERNAL QA SUMMARY  (OOM internal scorer — for comparison only)');
  console.log(LINE);
  console.log(`  READY rows:              ${readyRows.length}`);
  console.log(`  Successfully scored:     ${totalScored}`);
  if (totalErrored > 0) {
    console.log(`  Errored (not scored):    ${totalErrored}`);
  }
  console.log(`  Qualified (≥ ${SCORE_THRESHOLD}):       ${qualifiedRows.length} of ${totalScored}`);
  console.log(`  Not qualified:           ${totalScored - qualifiedRows.length} of ${totalScored}`);
  console.log(`  Average score:           ${totalScored > 0 ? avgScore.toFixed(2) : 'N/A'}`);
  console.log('');
  console.log('  Score distribution:');
  console.log(`    ≥ 9.0          :  ${scored.filter((r) => r.analysis.overallScore >= 9.0).length}`);
  console.log(`    8.0 – 8.9      :  ${band(8.0, 9.0)}`);
  console.log(`    7.0 – 7.9      :  ${band(7.0, 8.0)}`);
  console.log(`    below 7.0      :  ${scored.filter((r) => r.analysis.overallScore < 7.0).length}`);

  // ── Competitor benchmark summary (the primary lens for competitor ads) ──
  const avgBenchmark = totalScored > 0
    ? scored.reduce((sum, r) => sum + r.benchmark.benchmarkScore, 0) / totalScored
    : 0;
  const tierCount = (t: string) => scored.filter((r) => r.benchmark.tier === t).length;
  const confCount = (c: string) => scored.filter((r) => r.benchmark.confidence === c).length;

  console.log(`\n${LINE}`);
  console.log('  COMPETITOR BENCHMARK SUMMARY  (primary lens for competitor ads)');
  console.log(LINE);
  console.log(`  Average benchmark score: ${totalScored > 0 ? avgBenchmark.toFixed(2) : 'N/A'}`);
  console.log('');
  console.log('  Tier distribution:');
  console.log(`    Strong   (8.0–10) :  ${tierCount('Strong competitor signal')}`);
  console.log(`    Moderate (6.5–7.9):  ${tierCount('Moderate competitor signal')}`);
  console.log(`    Weak     (5.0–6.4):  ${tierCount('Weak competitor signal')}`);
  console.log(`    Low      (< 5.0)  :  ${tierCount('Low competitor signal')}`);
  console.log('');
  console.log('  Confidence distribution:');
  console.log(`    🟢 HIGH   (ASSET / Vision)        :  ${confCount('HIGH')}`);
  console.log(`    🟡 MEDIUM (MANUAL CSV text)       :  ${confCount('MEDIUM')}`);
  console.log(`    🔴 LOW    (FALLBACK / no evidence):  ${confCount('LOW')}`);
  const lowConf = confCount('MEDIUM') + confCount('LOW');
  if (lowConf > 0) {
    console.log('');
    console.log(`  ⚠  ${lowConf} row(s) are MEDIUM/LOW confidence — their benchmark scores`);
    console.log('     are based on manual text or no creative evidence, not Vision analysis.');
    console.log('     Do not rank them alongside HIGH-confidence rows without this caveat.');
  }

  // ── Final verdict ────────────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  FINAL VERDICT');
  console.log(LINE);

  const hasFail = totalErrored > 0;

  if (!hasFail) {
    const strong   = scored.filter((r) => r.benchmark.tier === 'Strong competitor signal').length;
    const moderate = scored.filter((r) => r.benchmark.tier === 'Moderate competitor signal').length;
    const highConf = scored.filter((r) => r.benchmark.confidence === 'HIGH').length;
    console.log(`\n  ✓ PASS`);
    console.log(`    ${totalScored} READY row(s) scored with 0 errors.`);
    console.log('');
    console.log('    Competitor benchmark (the decision lens for competitor ads):');
    console.log(`      ${strong} strong + ${moderate} moderate competitor signal(s); ${highConf}/${totalScored} are HIGH confidence (Vision).`);
    console.log('      Use the benchmark score + tier + confidence to rank competitor ads —');
    console.log('      NOT the internal QA "qualified ≥ 7" gate, which is built for OOM\'s own ads.');
    console.log('');
    console.log(`    (Internal QA: ${qualifiedRows.length}/${totalScored} would pass the 7.0 QA gate — shown for comparison only.)`);
    console.log('    Next step: confirm these benchmark scores look right before any ingestion work.');
  } else {
    console.log(`\n  ✗ FAIL`);
    console.log(`    ${totalErrored} row(s) errored during scoring.`);
    console.log('    Review error details above. Fix the CSV or scoring input before proceeding.');
    for (const e of errored) {
      console.log(`    Row ${e.rowNumber} (ad_id=${e.adId}): ${e.error}`);
    }
  }

  console.log('');
  printSafetyFooter(LINE);
}

function printSafetyFooter(LINE: string): void {
  console.log(LINE);
  console.log('  Safety confirmation');
  console.log(LINE);
  console.log('  No database writes were performed.');
  console.log('  No scoring changes were made.');
  console.log('  No ingestion was performed.');
  console.log('  data/imports/*.csv remains uncommitted by design.');
  console.log(LINE);
  console.log('');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('\n❌ Fatal error:', message);
  process.exit(1);
});
