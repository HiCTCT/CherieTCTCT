/**
 * Competitor DB-Shape & Product-Flow Preview  (PREVIEW / DESIGN ONLY)
 *
 * Shows how competitor benchmark fields would be used across the product flow:
 *     Home screen → Competitor detail page (many ads ranked) → Individual ad page
 *
 * Renders:
 *   0. Proposed stored record shape (existing QA fields + new benchmark fields)
 *   1. Home screen summary (pick a competitor)
 *   2. Competitor detail page — many ads ranked by competitor benchmark score
 *      (+ the underlying flat table)
 *   3. Individual ad detail page — benchmark first, internal QA second
 *   4. Suggested filters for the competitor detail page
 *
 * NOTHING is changed or written:
 *   - No Prisma/schema changes, no migration.
 *   - No database writes (no PrismaClient imported).
 *   - No ingestion changes.
 *   - The internal QA scorer and competitorScoring.ts are read-only here.
 *
 * Usage:
 *   DEMO mode (illustrative HipVan data, runs with no API/DB):
 *     set DEMO=true&& npx tsx scripts/preview-competitor-db-shape.ts
 *
 *   REAL mode (live numbers — needs ANTHROPIC_API_KEY + asset files):
 *     set BROWSER_ADS_FILE=data/imports/hipvan-browser-collected-ads-pilot-01.with-assets.csv&& npx tsx scripts/preview-competitor-db-shape.ts
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

// ─── The view model one ad would map to ────────────────────────────────────────

type AdView = {
  metaAdId: string;
  competitorName: string;
  mediaType: string;
  creativeSource: CreativeSource;
  internalQaScore: number;
  internalQaQualified: boolean;
  internalQaVerdict: string;
  benchmark: CompetitorBenchmark;
  recommendedUse: string;
};

// recommendedUse now comes from competitorScoring.ts (benchmark.recommendedUse) so
// the preview and ingestion share one source of truth.

function buildView(
  metaAdId: string,
  competitorName: string,
  mediaType: string,
  source: CreativeSource,
  analysis: AnalysisOutput,
): AdView {
  const benchmark = scoreCompetitorBenchmarkAd(analysis, source);
  return {
    metaAdId,
    competitorName,
    mediaType,
    creativeSource: source,
    internalQaScore: analysis.overallScore,
    internalQaQualified: analysis.qualified,
    internalQaVerdict: analysis.finalVerdict,
    benchmark,
    recommendedUse: benchmark.recommendedUse,
  };
}

// ─── DEMO data (illustrative HipVan ads) ────────────────────────────────────────
// Inputs are ILLUSTRATIVE placeholders so all tiers/confidences render — EXCEPT
// Row 7, which uses the real values you reported (AIDA 8/7/8/7 → QA 5.8).
// Benchmark scores below are computed by the REAL scoreCompetitorBenchmarkAd().

type DemoRow = {
  adId: string; media: string; source: CreativeSource;
  att: number; int: number; des: number; act: number;
  creativeScore: number; copyScore: number;
  qaScore: number; qaQualified: boolean; qaVerdict: string;
};

const DEMO_ROWS: DemoRow[] = [
  { adId: '834672038901155',  media: 'VIDEO',    source: 'ASSET',  att: 7, int: 6, des: 7, act: 6, creativeScore: 5.0, copyScore: 2.0, qaScore: 5.0, qaQualified: false, qaVerdict: 'CLEAR_IDEA_WEAK_SIGNALS' },
  { adId: '2208542812996603', media: 'VIDEO',    source: 'ASSET',  att: 8, int: 8, des: 8, act: 7, creativeScore: 6.0, copyScore: 2.0, qaScore: 6.0, qaQualified: false, qaVerdict: 'CLEAR_IDEA_WEAK_SIGNALS' },
  { adId: '588992234178859',  media: 'IMAGE',    source: 'MANUAL', att: 5, int: 4, des: 5, act: 5, creativeScore: 4.0, copyScore: 3.0, qaScore: 3.5, qaQualified: false, qaVerdict: 'TOO_VAGUE_MAJOR_REWORK' },
  { adId: '1849507992667319', media: 'VIDEO',    source: 'ASSET',  att: 9, int: 8, des: 9, act: 8, creativeScore: 7.0, copyScore: 3.0, qaScore: 6.5, qaQualified: false, qaVerdict: 'CLEAR_IDEA_WEAK_SIGNALS' },
  { adId: '1266401571739041', media: 'VIDEO',    source: 'ASSET',  att: 7, int: 7, des: 8, act: 7, creativeScore: 6.0, copyScore: 2.0, qaScore: 5.9, qaQualified: false, qaVerdict: 'CLEAR_IDEA_WEAK_SIGNALS' },
  { adId: '1529082608446620', media: 'CAROUSEL', source: 'ASSET',  att: 8, int: 7, des: 8, act: 7, creativeScore: 5.0, copyScore: 1.0, qaScore: 5.8, qaQualified: false, qaVerdict: 'CLEAR_IDEA_WEAK_SIGNALS' }, // REAL row 7
  { adId: '1292217932374093', media: 'IMAGE',    source: 'ASSET',  att: 6, int: 6, des: 7, act: 6, creativeScore: 5.0, copyScore: 2.0, qaScore: 5.2, qaQualified: false, qaVerdict: 'CLEAR_IDEA_WEAK_SIGNALS' },
  { adId: '1260604046097969', media: 'VIDEO',    source: 'MANUAL', att: 4, int: 4, des: 5, act: 4, creativeScore: 4.0, copyScore: 2.0, qaScore: 3.2, qaQualified: false, qaVerdict: 'TOO_VAGUE_MAJOR_REWORK' },
  { adId: '1946483322947552', media: 'IMAGE',    source: 'ASSET',  att: 8, int: 7, des: 8, act: 8, creativeScore: 6.0, copyScore: 3.0, qaScore: 6.1, qaQualified: false, qaVerdict: 'CLEAR_IDEA_WEAK_SIGNALS' },
  { adId: '1012596470876457', media: 'IMAGE',    source: 'ASSET',  att: 9, int: 8, des: 9, act: 9, creativeScore: 8.0, copyScore: 4.0, qaScore: 6.8, qaQualified: false, qaVerdict: 'CLEAR_IDEA_WEAK_SIGNALS' },
];

function demoViews(): AdView[] {
  return DEMO_ROWS.map((d) => {
    const analysis = {
      overallScore: d.qaScore,
      qualified: d.qaQualified,
      finalVerdict: d.qaVerdict,
      aidaScores: { attention: d.att, interest: d.int, desire: d.des, action: d.act },
      creativeScore: d.creativeScore,
      copyScore: d.copyScore,
    } as unknown as AnalysisOutput;
    return buildView(d.adId, 'HipVan', d.media, d.source, analysis);
  });
}

// ─── REAL mode (reads the CSV like browser:preview) ─────────────────────────────

const EXPECTED_HEADER = [
  'collection_status', 'competitor_name', 'meta_page_id', 'ad_id', 'ad_library_url',
  'media_type', 'publisher_platforms', 'ad_delivery_start_time', 'ad_copy', 'headline',
  'description', 'landing_page_url', 'notes', 'visual_description', 'creative_notes',
] as const;

function deriveFormat(mediaType: string): AdFormat | null {
  const mt = mediaType.trim().toUpperCase();
  if (mt === 'IMAGE' || mt === 'CAROUSEL') return 'STATIC';
  if (mt === 'VIDEO') return 'VIDEO';
  return null;
}

function toExampleRow(row: Record<string, string>, creative: CreativeContext): ExampleRow {
  const copy = (row.ad_copy ?? '').trim();
  return {
    Product:             (row.competitor_name ?? '').trim() || 'Unknown Advertiser',
    'Ad Link':           (row.ad_library_url ?? '').trim()  || undefined,
    Copy:                copy || undefined,
    Headline:            (row.headline ?? '').trim()        || undefined,
    Description:         (row.description ?? '').trim()      || undefined,
    'Active Since':      (row.ad_delivery_start_time ?? '').trim() || undefined,
    Analysis:            creative.creative_notes      || undefined,
    'Creative Analysis': creative.visual_description  || undefined,
    Improvement:              undefined,
    'Creative Improvements':  undefined,
    'Other Feedbacks':        undefined,
  };
}

async function realViews(filePath: string): Promise<AdView[]> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const rawRows = parse(content, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  const missing = EXPECTED_HEADER.filter((c) => !Object.keys(rawRows[0] ?? {}).includes(c));
  if (missing.length > 0) throw new Error(`Missing columns: ${missing.join(', ')}`);

  const ready = rawRows.filter((r) => (r.collection_status ?? '').trim().toUpperCase() === 'READY');
  const withAssets = ready.filter((r) => r.creative_asset_path?.trim());
  if (withAssets.length > 0 && !process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error(`${withAssets.length} READY row(s) have creative_asset_path — set ANTHROPIC_API_KEY, or use DEMO=true.`);
  }

  const views: AdView[] = [];
  for (const row of ready) {
    const format = deriveFormat(row.media_type ?? '');
    if (!format) continue;
    const creative = await resolveCreativeContext(row, row.media_type ?? '');
    const analysis = analyseAdRow(toExampleRow(row, creative), format);
    views.push(buildView(
      (row.ad_id ?? '').trim(),
      (row.competitor_name ?? '').trim() || 'Unknown',
      (row.media_type ?? '').trim().toUpperCase(),
      creative.source,
      analysis,
    ));
  }
  return views;
}

// ─── Render helpers ─────────────────────────────────────────────────────────────

const LINE = '═'.repeat(112);
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const padL = (s: string, n: number) => s.padStart(n);
const confIcon = (c: string) => (c === 'HIGH' ? '🟢' : c === 'MEDIUM' ? '🟡' : '🔴');
const tierShort = (t: string) => t.replace(' competitor signal', '');
const evidenceShort = (s: CreativeSource) => (s === 'ASSET' ? 'Vision' : s === 'MANUAL' ? 'Manual' : 'None');
const ranked = (views: AdView[]) => [...views].sort((a, b) => b.benchmark.benchmarkScore - a.benchmark.benchmarkScore);

// ─── 0. Proposed stored record shape ────────────────────────────────────────────

function renderRecordShape(): void {
  console.log(`\n${LINE}`);
  console.log('  PROPOSED STORED RECORD SHAPE  (design only — NOT a migration)');
  console.log(LINE);
  console.log(`
  CompetitorAd (one row per ad) {
    // ── existing internal QA fields (UNCHANGED — already stored today) ──
    metaAdId            string
    competitorName      string
    mediaType           "IMAGE" | "CAROUSEL" | "VIDEO"
    creativeSource      "ASSET" | "MANUAL" | "FALLBACK"
    internalQaScore     float     // analysis.overallScore (OOM internal QA scorer)
    internalQaQualified boolean    // analysis.qualified (≥ 7.0 gate)
    internalQaVerdict   string     // finalVerdict

    // ── NEW competitor benchmark fields (used mainly on the COMPETITOR page) ──
    competitorBenchmarkScore float   // 0–10, competitor lens — primary ranking key
    benchmarkTier            string  // Strong | Moderate | Weak | Low competitor signal
    confidenceLevel          string  // HIGH (Vision) | MEDIUM (manual) | LOW (none)
    evidenceSource           string  // Vision creative analysis | Manual CSV text | No evidence
    recommendedUse           string  // derived guidance for the analyst
  }

  Usage: benchmark* fields drive the COMPETITOR detail page (ranking + filtering many
  ads). internalQa* fields stay on the INDIVIDUAL AD page as a secondary "for comparison"
  panel. Neither overwrites the other. Adding benchmark* is a future additive migration —
  none is created here.`);
}

// ─── 1. Home screen ──────────────────────────────────────────────────────────────

function renderHomeScreen(views: AdView[]): void {
  console.log(`\n${LINE}`);
  console.log('  MOCK · STEP 1 — HOME SCREEN  (pick a competitor)');
  console.log(LINE);
  const tc = (t: string) => views.filter((v) => v.benchmark.tier === t).length;
  const high = views.filter((v) => v.benchmark.confidence === 'HIGH').length;
  const avg = views.length ? views.reduce((s, v) => s + v.benchmark.benchmarkScore, 0) / views.length : 0;
  const top = ranked(views)[0];
  const name = views[0]?.competitorName ?? 'Competitor';

  console.log('\n  Competitors tracked              ads   avg BM   tiers S/M/W/L   HIGH-conf   top ad');
  console.log('  ' + '─'.repeat(92));
  const row = (nm: string, ads: string, a: string, mix: string, h: string, topd: string) =>
    console.log(`  ▸ ${pad(nm, 28)} ${padL(ads, 4)}   ${padL(a, 6)}   ${pad(mix, 12)}   ${padL(h, 8)}   ${topd}`);

  row(`${name}  (live)`, String(views.length), avg.toFixed(1),
    `${tc('Strong competitor signal')}/${tc('Moderate competitor signal')}/${tc('Weak competitor signal')}/${tc('Low competitor signal')}`,
    `${high}/${views.length}`,
    top ? `${top.benchmark.benchmarkScore.toFixed(1)} ${top.mediaType}` : '—');
  // Illustrative additional competitors so the "list of competitors" layout is visible.
  row('Castlery  (illustrative)',   '14', '6.1', '3/5/4/2', '12/14', '8.7 VIDEO');
  row('Wellaholic  (illustrative)', '0',  'N/A', '0/0/0/0', '0/0',   '— not collected yet');

  console.log('\n  → Click a competitor to open its detail page (ads ranked by competitor benchmark).');
  console.log('  (Rows marked illustrative are placeholders for layout; only ' + name + ' has live data.)');
}

// ─── 2. Competitor detail page (the home of benchmark fields) ────────────────────

function renderCompetitorPage(views: AdView[]): void {
  console.log(`\n${LINE}`);
  console.log('  MOCK · STEP 2 — COMPETITOR DETAIL PAGE  (this is where benchmark fields live)');
  console.log(LINE);
  const name = views[0]?.competitorName ?? 'Competitor';
  console.log(`  ${name} · ${views.length} ads tracked`);
  console.log('  Sort: [ Benchmark score ▼ ]   Filter: [ Tier ] [ Confidence ] [ Format ] [ Creative source ]\n');

  ranked(views).forEach((v, i) => {
    const badge = `${confIcon(v.benchmark.confidence)} ${v.benchmark.confidence}`;
    console.log(`  ${padL(String(i + 1), 2)}. ${pad(tierShort(v.benchmark.tier), 9)} ${v.benchmark.benchmarkScore.toFixed(1)}/10  ` +
      `${pad(v.mediaType, 9)} ${pad('#' + v.metaAdId, 18)} ${pad(badge, 10)} ${evidenceShort(v.creativeSource)}`);
    console.log(`        ${v.recommendedUse}`);
  });
  console.log('\n  Legend: 🟢 HIGH = creative seen by Vision   🟡 MEDIUM = manual text only   🔴 LOW = no creative');
  console.log('  (Internal QA score is NOT shown here — it lives on the individual ad page, for comparison.)');

  // Underlying flat data behind the page.
  console.log(`\n  ── Underlying data (flat table) ──`);
  const header =
    pad('metaAdId', 18) + pad('media', 9) + pad('source', 8) + padL('BM', 5) + '  ' +
    pad('tier', 10) + pad('conf', 8) + pad('evidence', 9) + padL('QA', 5) + '  ' + 'QA?';
  console.log('  ' + header);
  console.log('  ' + '─'.repeat(header.length));
  for (const v of ranked(views)) {
    console.log('  ' +
      pad(v.metaAdId, 18) + pad(v.mediaType, 9) + pad(v.creativeSource, 8) +
      padL(v.benchmark.benchmarkScore.toFixed(1), 5) + '  ' +
      pad(tierShort(v.benchmark.tier), 10) +
      pad(`${confIcon(v.benchmark.confidence)}${v.benchmark.confidence}`, 8) +
      pad(evidenceShort(v.creativeSource), 9) +
      padL(v.internalQaScore.toFixed(1), 5) + '  ' + (v.internalQaQualified ? 'YES' : 'NO'));
  }
}

// ─── 3. Individual ad detail page (benchmark first, QA second) ───────────────────

function renderAdDetailPage(v: AdView): void {
  console.log(`\n${LINE}`);
  console.log('  MOCK · STEP 3 — INDIVIDUAL AD DETAIL PAGE  (benchmark first, internal QA second)');
  console.log(LINE);
  console.log(`
  HipVan · ${v.mediaType} · ad #${v.metaAdId}
  Creative source: ${v.creativeSource} (${v.benchmark.evidenceSource})

  [ Creative assets ]  card-01.png · card-02.png · card-03.png   (from the capture pipeline)

  ★ COMPETITOR BENCHMARK  (primary)
      Benchmark score:  ${v.benchmark.benchmarkScore.toFixed(1)} / 10
      Tier:             ${v.benchmark.tier}
      Confidence:       ${confIcon(v.benchmark.confidence)} ${v.benchmark.confidence}
      Evidence source:  ${v.benchmark.evidenceSource}
      Formula:          ${v.benchmark.formula}
      Recommended use:  ${v.recommendedUse}${v.benchmark.warning ? `\n      ⚠  ${v.benchmark.warning}` : ''}

  Full AIDA / creative analysis
      (the per-dimension AIDA scores, creative notes, behavioural triggers, funnel/RACE
       stage, strengths/weaknesses — same detail the analyser already produces.)

  ── secondary ──────────────────────────────────────────────────────────────
  Internal Ad QA Score   (OOM QA score — for comparison only, collapsed by default)
      Score:    ${v.internalQaScore.toFixed(1)} / 10      qualified: ${v.internalQaQualified ? 'YES' : 'NO'}
      Verdict:  ${v.internalQaVerdict}
      Note: the OOM QA gate is built for OOM's own ads (full copy). For competitor ads
            with little copy it under-scores — use the competitor benchmark above to decide.`);
}

// ─── 4. Suggested filters for the competitor page ────────────────────────────────

function renderFilters(views: AdView[]): void {
  const count = (pred: (v: AdView) => boolean) => views.filter(pred).length;
  console.log(`\n${LINE}`);
  console.log('  MOCK · STEP 4 — SUGGESTED FILTERS  (competitor detail page)');
  console.log(LINE);
  console.log(`
  Sort by:          [ Benchmark score ▼ ]  (default)   ·   newest   ·   longest-running

  Benchmark tier:
    [ ] Strong   (${count((v) => v.benchmark.tier === 'Strong competitor signal')})
    [ ] Moderate (${count((v) => v.benchmark.tier === 'Moderate competitor signal')})
    [ ] Weak     (${count((v) => v.benchmark.tier === 'Weak competitor signal')})
    [ ] Low      (${count((v) => v.benchmark.tier === 'Low competitor signal')})

  Confidence level:
    [ ] 🟢 HIGH   — creative analysed by Vision   (${count((v) => v.benchmark.confidence === 'HIGH')})
    [ ] 🟡 MEDIUM — manual CSV text only          (${count((v) => v.benchmark.confidence === 'MEDIUM')})
    [ ] 🔴 LOW    — no creative evidence          (${count((v) => v.benchmark.confidence === 'LOW')})

  Evidence source:  [ ] Vision   [ ] Manual   [ ] None
  Creative source:  [ ] ASSET    [ ] MANUAL   [ ] FALLBACK
  Media type:       [ ] IMAGE    [ ] CAROUSEL [ ] VIDEO
  Benchmark score:  [ min ___ ]  to  [ max ___ ]

  Default view: HIGH-confidence ads only, sorted by benchmark score (desc).
  (Internal QA "qualified" is intentionally NOT a competitor-page filter — it lives on the ad page.)`);
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const demo = process.env.DEMO === 'true';
  const filePath = process.env.BROWSER_ADS_FILE ? path.resolve(process.env.BROWSER_ADS_FILE) : '';

  console.log(`\n${LINE}`);
  console.log('  COMPETITOR DB-SHAPE & PRODUCT-FLOW PREVIEW   (PREVIEW / DESIGN ONLY — no DB, no Prisma, no writes)');
  console.log('  Flow:  Home screen → Competitor detail page → Individual ad page');
  console.log(LINE);

  let views: AdView[];
  if (demo || !filePath) {
    console.log('  Source: DEMO data (illustrative; Row 7 = real reported values).');
    console.log('  Run with BROWSER_ADS_FILE=<with-assets.csv> + ANTHROPIC_API_KEY for live numbers.');
    views = demoViews();
  } else {
    console.log(`  Source: ${filePath} (live analysis)`);
    views = await realViews(filePath);
  }

  renderRecordShape();
  renderHomeScreen(views);
  renderCompetitorPage(views);
  // Step 3: show the real Row 7 carousel if present, else the top-ranked ad.
  const row7 = views.find((v) => v.metaAdId === '1529082608446620');
  renderAdDetailPage(row7 ?? ranked(views)[0]!);
  renderFilters(views);

  console.log(`\n${LINE}`);
  console.log('  PREVIEW ONLY — no schema change, no migration, no DB write, no ingestion change.');
  console.log(LINE + '\n');
}

main().catch((err: unknown) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
