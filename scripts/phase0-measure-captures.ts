/**
 * Phase 0: Local capture-measurement report  (READ-ONLY, no DB)
 *
 * Reads existing browser-capture outputs already on disk and produces a local
 * measurement report so we can judge capture quality and cost BEFORE any Phase 1
 * automation. It does NOT run a browser, does NOT call Anthropic / Vision, does
 * NOT touch Prisma / SQLite / ingestion, and WRITES nothing except one local
 * report file under data/imports/phase0-reports/ (git-ignored).
 *
 * What it measures, per competitor and overall:
 *   - creative asset counts by type: IMAGE (image-*.png), CAROUSEL_CARD
 *     (card-*.png), VIDEO_FRAME (frame-*.png), plus video source files (video.*).
 *   - asset bytes by type (sum of file sizes) — a rough storage/cost proxy.
 *   - verified-meta sidecar quality: ACCEPT / REVIEW / REJECT counts for
 *     headline_status, description_status, verification_status.
 *   - the REVIEW / REJECT reasons, tallied, so the most common quality failures
 *     are visible.
 *   - collection_status (READY vs NEEDS_REVIEW) from any *.with-assets.csv.
 *
 * These are diagnostics about CAPTURE OUTPUT ALREADY ON DISK. They never imply a
 * competitor's true ad count and are never written back to any database.
 *
 * Usage:
 *   set ASSETS_DIR=data/creative-assets      (optional; this is the default)
 *   set IMPORTS_DIR=data/imports             (optional; this is the default)
 *   set COMPETITOR=castlery                  (optional; filter to one folder)
 *   npm run phase0:measure-captures
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const ASSETS_DIR = path.resolve((process.env.ASSETS_DIR ?? 'data/creative-assets').trim());
const IMPORTS_DIR = path.resolve((process.env.IMPORTS_DIR ?? 'data/imports').trim());
const COMPETITOR_FILTER = (process.env.COMPETITOR ?? '').trim().toLowerCase();

type AssetTally = {
  image_count: number;
  carousel_card_count: number;
  video_frame_count: number;
  video_source_count: number;
  image_bytes: number;
  carousel_card_bytes: number;
  video_frame_bytes: number;
  video_source_bytes: number;
};

type StatusTally = { ACCEPT: number; REVIEW: number; REJECT: number; OTHER: number };

function emptyAssets(): AssetTally {
  return {
    image_count: 0, carousel_card_count: 0, video_frame_count: 0, video_source_count: 0,
    image_bytes: 0, carousel_card_bytes: 0, video_frame_bytes: 0, video_source_bytes: 0,
  };
}
function emptyStatus(): StatusTally { return { ACCEPT: 0, REVIEW: 0, REJECT: 0, OTHER: 0 }; }

function addStatus(t: StatusTally, raw: string): void {
  const v = (raw || '').trim().toUpperCase();
  if (v === 'ACCEPT') t.ACCEPT++;
  else if (v === 'REVIEW') t.REVIEW++;
  else if (v === 'REJECT') t.REJECT++;
  else t.OTHER++;
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

function fileBytes(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

// Tally one ad folder's creative assets (read-only). Debug-* and *.txt notes are
// intentionally excluded — they are not creative deliverables.
function tallyAdAssets(adDir: string, t: AssetTally): void {
  let files: string[] = [];
  try { files = fs.readdirSync(adDir); } catch { return; }
  for (const f of files) {
    const full = path.join(adDir, f);
    if (/^image-\d+\.png$/i.test(f)) { t.image_count++; t.image_bytes += fileBytes(full); }
    else if (/^card-\d+\.png$/i.test(f)) { t.carousel_card_count++; t.carousel_card_bytes += fileBytes(full); }
    else if (/^frame-\d+\.png$/i.test(f)) { t.video_frame_count++; t.video_frame_bytes += fileBytes(full); }
    else if (/^video\.\w+$/i.test(f)) { t.video_source_count++; t.video_source_bytes += fileBytes(full); }
  }
}

function mb(bytes: number): string { return (bytes / (1024 * 1024)).toFixed(2) + ' MB'; }

function main(): void {
  const LINE = '═'.repeat(64);
  console.log(`\n${LINE}`);
  console.log('  phase0-measure-captures (READ-ONLY local report)');
  console.log(LINE);
  console.log(`  Assets dir:   ${ASSETS_DIR}`);
  console.log(`  Imports dir:  ${IMPORTS_DIR}`);
  if (COMPETITOR_FILTER) console.log(`  Competitor:   ${COMPETITOR_FILTER} (filtered)`);
  console.log(LINE);

  // ── 1. Creative assets on disk, by competitor ──
  const perCompetitorAssets: Record<string, AssetTally & { ad_folders: number }> = {};
  const overallAssets = emptyAssets();
  let overallAdFolders = 0;

  for (const comp of listDirs(ASSETS_DIR)) {
    if (COMPETITOR_FILTER && comp.toLowerCase() !== COMPETITOR_FILTER) continue;
    const compDir = path.join(ASSETS_DIR, comp);
    const t = emptyAssets();
    let adFolders = 0;
    for (const ad of listDirs(compDir)) {
      adFolders++;
      tallyAdAssets(path.join(compDir, ad), t);
    }
    perCompetitorAssets[comp] = { ...t, ad_folders: adFolders };
    overallAdFolders += adFolders;
    overallAssets.image_count += t.image_count;
    overallAssets.carousel_card_count += t.carousel_card_count;
    overallAssets.video_frame_count += t.video_frame_count;
    overallAssets.video_source_count += t.video_source_count;
    overallAssets.image_bytes += t.image_bytes;
    overallAssets.carousel_card_bytes += t.carousel_card_bytes;
    overallAssets.video_frame_bytes += t.video_frame_bytes;
    overallAssets.video_source_bytes += t.video_source_bytes;
  }

  // ── 2. Verified-meta sidecar quality ──
  const headlineStatus = emptyStatus();
  const descriptionStatus = emptyStatus();
  const verificationStatus = emptyStatus();
  const reviewReasons: Record<string, number> = {};
  const rejectReasons: Record<string, number> = {};
  let verifiedRows = 0;
  const sidecarFiles: string[] = [];
  const captureStrategyCounts: Record<string, number> = {};

  let importFiles: string[] = [];
  try { importFiles = fs.readdirSync(IMPORTS_DIR); } catch { importFiles = []; }

  for (const f of importFiles) {
    if (!/\.verified-meta\.csv$/i.test(f)) continue;
    if (COMPETITOR_FILTER && !f.toLowerCase().includes(COMPETITOR_FILTER)) continue;
    const full = path.join(IMPORTS_DIR, f);
    sidecarFiles.push(f);
    let records: Record<string, string>[] = [];
    try {
      records = parse(fs.readFileSync(full, 'utf-8'), { columns: true, skip_empty_lines: true }) as Record<string, string>[];
    } catch (err: unknown) {
      console.log(`  ⚠ could not parse ${f}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const r of records) {
      verifiedRows++;
      addStatus(headlineStatus, r.headline_status ?? '');
      addStatus(descriptionStatus, r.description_status ?? '');
      addStatus(verificationStatus, r.verification_status ?? '');
      const cs = (r.capture_strategy ?? '').trim() || '(none)';
      captureStrategyCounts[cs] = (captureStrategyCounts[cs] ?? 0) + 1;
      const hs = (r.headline_status ?? '').trim().toUpperCase();
      const ds = (r.description_status ?? '').trim().toUpperCase();
      if (hs === 'REVIEW' && r.headline_reason) reviewReasons[r.headline_reason] = (reviewReasons[r.headline_reason] ?? 0) + 1;
      if (hs === 'REJECT' && r.headline_reason) rejectReasons[r.headline_reason] = (rejectReasons[r.headline_reason] ?? 0) + 1;
      if (ds === 'REVIEW' && r.description_reason) reviewReasons[r.description_reason] = (reviewReasons[r.description_reason] ?? 0) + 1;
      if (ds === 'REJECT' && r.description_reason) rejectReasons[r.description_reason] = (rejectReasons[r.description_reason] ?? 0) + 1;
    }
  }

  // ── 3. collection_status from *.with-assets.csv (READY vs NEEDS_REVIEW) ──
  let readyCount = 0;
  let needsReviewCount = 0;
  let otherStatusCount = 0;
  const withAssetsFiles: string[] = [];
  for (const f of importFiles) {
    if (!/\.with-assets\.csv$/i.test(f)) continue;
    if (COMPETITOR_FILTER && !f.toLowerCase().includes(COMPETITOR_FILTER)) continue;
    const full = path.join(IMPORTS_DIR, f);
    withAssetsFiles.push(f);
    let records: Record<string, string>[] = [];
    try {
      records = parse(fs.readFileSync(full, 'utf-8'), { columns: true, skip_empty_lines: true }) as Record<string, string>[];
    } catch { continue; }
    for (const r of records) {
      const s = (r.collection_status ?? '').trim().toUpperCase();
      if (s === 'READY') readyCount++;
      else if (s === 'NEEDS_REVIEW') needsReviewCount++;
      else otherStatusCount++;
    }
  }

  // ── Console summary ──
  console.log('\n── Creative assets on disk (by competitor) ──');
  for (const [comp, t] of Object.entries(perCompetitorAssets)) {
    console.log(`  ${comp}: ${t.ad_folders} ad folder(s) | IMAGE ${t.image_count}, CAROUSEL_CARD ${t.carousel_card_count}, VIDEO_FRAME ${t.video_frame_count}, video src ${t.video_source_count}`);
  }
  console.log('\n── Creative assets overall ──');
  console.log(`  ad folders:    ${overallAdFolders}`);
  console.log(`  IMAGE:         ${overallAssets.image_count} files, ${mb(overallAssets.image_bytes)}`);
  console.log(`  CAROUSEL_CARD: ${overallAssets.carousel_card_count} files, ${mb(overallAssets.carousel_card_bytes)}`);
  console.log(`  VIDEO_FRAME:   ${overallAssets.video_frame_count} files, ${mb(overallAssets.video_frame_bytes)}`);
  console.log(`  video source:  ${overallAssets.video_source_count} files, ${mb(overallAssets.video_source_bytes)}`);

  console.log('\n── Verified-meta quality (sidecars) ──');
  console.log(`  sidecar files: ${sidecarFiles.length}, rows: ${verifiedRows}`);
  console.log(`  headline_status:     ACCEPT ${headlineStatus.ACCEPT}, REVIEW ${headlineStatus.REVIEW}, REJECT ${headlineStatus.REJECT}, other ${headlineStatus.OTHER}`);
  console.log(`  description_status:  ACCEPT ${descriptionStatus.ACCEPT}, REVIEW ${descriptionStatus.REVIEW}, REJECT ${descriptionStatus.REJECT}, other ${descriptionStatus.OTHER}`);
  console.log(`  verification_status: ACCEPT ${verificationStatus.ACCEPT}, REVIEW ${verificationStatus.REVIEW}, REJECT ${verificationStatus.REJECT}, other ${verificationStatus.OTHER}`);

  const topReasons = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (Object.keys(rejectReasons).length) {
    console.log('\n  Top REJECT reasons:');
    for (const [r, n] of topReasons(rejectReasons)) console.log(`    ${n}×  ${r}`);
  }
  if (Object.keys(reviewReasons).length) {
    console.log('\n  Top REVIEW reasons:');
    for (const [r, n] of topReasons(reviewReasons)) console.log(`    ${n}×  ${r}`);
  }

  console.log('\n── collection_status (with-assets CSVs) ──');
  console.log(`  files: ${withAssetsFiles.length} | READY ${readyCount}, NEEDS_REVIEW ${needsReviewCount}, other ${otherStatusCount}`);

  // ── Write local JSON report (git-ignored) ──
  const report = {
    schema: 'phase0-capture-measurement/1',
    generated_at: new Date().toISOString(),
    read_only: true,
    no_db_writes: true,
    inputs: { assets_dir: ASSETS_DIR, imports_dir: IMPORTS_DIR, competitor_filter: COMPETITOR_FILTER || null },
    assets: {
      overall: { ad_folders: overallAdFolders, ...overallAssets },
      by_competitor: perCompetitorAssets,
    },
    verified_meta: {
      sidecar_files: sidecarFiles,
      rows: verifiedRows,
      headline_status: headlineStatus,
      description_status: descriptionStatus,
      verification_status: verificationStatus,
      capture_strategy_counts: captureStrategyCounts,
      reject_reasons: rejectReasons,
      review_reasons: reviewReasons,
    },
    collection_status: {
      with_assets_files: withAssetsFiles,
      ready: readyCount,
      needs_review: needsReviewCount,
      other: otherStatusCount,
    },
    notes:
      'Read-only measurement of capture output already on disk. Counts describe ' +
      'captured assets / sidecar rows, never a competitor\'s true ad inventory. No DB writes.',
  };

  const reportsDir = path.join(IMPORTS_DIR, 'phase0-reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportsDir, `phase0-capture-measurement.${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');

  console.log(`\n${LINE}`);
  console.log(`  Report: ${reportPath}  (local only — git-ignored)`);
  console.log('  READ-ONLY. No browser, no Vision/API, no DB writes, no ingestion.');
  console.log(`${LINE}\n`);
}

main();
