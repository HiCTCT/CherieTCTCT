/**
 * Run One-Competitor Browser Workflow  (Phase B)
 *
 * Orchestrates the EXISTING browser-collection commands end-to-end for ONE
 * competitor, then prints a single workflow summary:
 *
 *   create CSV            (browser:create-csv)
 *   → validate CSV        (browser:validate)
 *   → capture assets      (browser:capture-assets)  → produces .with-assets.csv
 *   → validate enriched   (browser:validate on the .with-assets.csv)
 *   → preview scoring     (browser:preview)
 *   → summary
 *
 * This is a THIN orchestrator. It does NOT touch scoring, ingestion, DB, Prisma,
 * the dashboard UI, or capture logic. It only spawns the existing npm scripts,
 * passing the right env vars, gates each step on its exit code, and parses
 * counts from each step's stdout for the summary. No DB writes. No ingestion.
 *
 * If any step fails (non-zero exit), the workflow STOPS and prints the failed
 * step clearly.
 *
 * Inputs (env):
 *   COMPETITOR_NAME                          (required)
 *   META_PAGE_ID  or  META_AD_LIBRARY_URL    (one required)
 *   OUTPUT_BASENAME                          (required) e.g. rentokil-origin-...-pilot-01
 *   MAX_ADS        (default 10)
 *   HEADLESS       ('true' = headless; default headful)
 *   DEBUG_CAPTURE  ('true' = capture debug files)
 *
 * Example:
 *   set "COMPETITOR_NAME=ORIGIN Exterminators"
 *   set "META_PAGE_ID=193665894008173"
 *   set "OUTPUT_BASENAME=rentokil-origin-browser-collected-ads-pilot-01"
 *   set "MAX_ADS=10"
 *   set "HEADLESS=false"
 *   set "DEBUG_CAPTURE=true"
 *   npm run browser:workflow-one
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const LINE = '═'.repeat(64);
const SUB = '─'.repeat(64);

// ─── Inputs ───────────────────────────────────────────────────────────────────

const COMPETITOR_NAME = (process.env.COMPETITOR_NAME ?? '').trim();
const META_PAGE_ID = (process.env.META_PAGE_ID ?? '').trim();
const META_AD_LIBRARY_URL = (process.env.META_AD_LIBRARY_URL ?? '').trim();
const OUTPUT_BASENAME = (process.env.OUTPUT_BASENAME ?? '').trim();
const MAX_ADS = (process.env.MAX_ADS ?? '10').trim();
const HEADLESS = (process.env.HEADLESS ?? '').trim();
const DEBUG_CAPTURE = (process.env.DEBUG_CAPTURE ?? '').trim();

function fail(step: string, code: number, hint?: string): never {
  console.error(`\n${LINE}`);
  console.error('  ❌ WORKFLOW STOPPED');
  console.error(SUB);
  console.error(`  Failed step:  ${step}`);
  console.error(`  Exit code:    ${code}`);
  if (hint) console.error(`  Next:         ${hint}`);
  console.error(`${LINE}\n`);
  process.exit(1);
}

type StepResult = { code: number; out: string };

// Invoke npm without tripping two Node footguns at once:
//   - DEP0190: passing an args array together with shell:true is deprecated, so
//     shell stays FALSE here.
//   - CVE-2024-27980 hardening: on patched Node, spawning a .cmd/.bat (e.g.
//     npm.cmd) with shell:false throws EINVAL with no output — which is exactly
//     the "stops at Step 1, exit 1, no output" symptom.
// Fix: on Windows spawn the REAL executable cmd.exe and let it run npm; on POSIX
// spawn npm directly. shell stays false in both cases, args stay an array.
const IS_WIN = process.platform === 'win32';

function runStep(title: string, npmScript: string, extraEnv: Record<string, string>): StepResult {
  console.log(`\n${LINE}`);
  console.log(`  ▶  ${title}`);
  console.log(`     npm run ${npmScript}`);
  console.log(LINE);
  const cmd = IS_WIN ? 'cmd.exe' : 'npm';
  const args = IS_WIN ? ['/c', 'npm', 'run', npmScript] : ['run', npmScript];
  const res = spawnSync(cmd, args, {
    env: { ...process.env, ...extraEnv },
    encoding: 'utf-8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (out.trim()) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  if (res.error) console.error(`  ⚠ spawn error invoking npm: ${res.error.message}`);
  const code = typeof res.status === 'number' ? res.status : 1;
  return { code, out };
}

function num(text: string, re: RegExp): string {
  const m = text.match(re);
  return m && m[1] !== undefined ? m[1] : 'n/a';
}
function verdict(text: string): string {
  if (/✓\s*PASS/.test(text)) return 'PASS';
  if (/✗\s*FAIL/.test(text)) return 'FAIL';
  return 'unknown';
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  console.log(`\n${LINE}`);
  console.log('  One-Competitor Browser Workflow (Phase B)');
  console.log(LINE);

  const errs: string[] = [];
  if (!COMPETITOR_NAME) errs.push('COMPETITOR_NAME is required.');
  if (!OUTPUT_BASENAME) errs.push('OUTPUT_BASENAME is required.');
  if (!META_PAGE_ID && !META_AD_LIBRARY_URL) errs.push('Provide META_PAGE_ID or META_AD_LIBRARY_URL.');
  if (errs.length) { console.error('\n❌ ' + errs.join('\n   ')); process.exit(1); }

  const csvFile = path.join('data', 'imports', `${OUTPUT_BASENAME}.csv`);
  const assetsCsv = path.join('data', 'imports', `${OUTPUT_BASENAME}.with-assets.csv`);

  console.log(`  Competitor:      ${COMPETITOR_NAME}`);
  console.log(`  Page/URL:        ${META_PAGE_ID || META_AD_LIBRARY_URL}`);
  console.log(`  CSV:             ${csvFile}`);
  console.log(`  Enriched CSV:    ${assetsCsv}`);
  console.log(`  Max ads:         ${MAX_ADS}`);
  console.log(`  Headless:        ${HEADLESS === 'true' ? 'yes' : 'no'}`);
  console.log(`  Debug capture:   ${DEBUG_CAPTURE === 'true' ? 'on' : 'off'}`);

  // Collected for the final summary
  const s = {
    csvCreated: false,
    initialVerdict: 'unknown',
    ready: 'n/a',
    needsReview: 'n/a',
    captured: 'n/a',
    inactive: 'n/a',
    noContainer: 'n/a',
    qualitySkipped: 'n/a',
    failed: 'n/a',
    enrichedVerdict: 'unknown',
    previewVerdict: 'unknown',
    scored: 'n/a',
    visionHigh: 'n/a',
    manualMedium: 'n/a',
    errors: 'n/a',
  };

  // ── Step 1: create CSV ──
  const r1 = runStep('Step 1/5 — Create CSV from Meta Ad Library', 'browser:create-csv', { OUTPUT_FILE: csvFile });
  if (r1.code !== 0) fail('create CSV (browser:create-csv)', r1.code, `Inspect the run, then check ${csvFile}.`);
  if (!fs.existsSync(csvFile)) fail('create CSV (browser:create-csv)', 1, `Expected ${csvFile} was not created.`);
  s.csvCreated = true;

  // ── Step 2: validate created CSV ──
  const r2 = runStep('Step 2/5 — Validate created CSV', 'browser:validate', { BROWSER_ADS_FILE: csvFile });
  s.initialVerdict = verdict(r2.out);
  s.ready = num(r2.out, /READY:\s+(\d+)/);
  s.needsReview = num(r2.out, /NEEDS_REVIEW:\s+(\d+)/);
  if (r2.code !== 0) fail('initial CSV validation (browser:validate)', r2.code, `Fix the rows flagged above in ${csvFile}.`);

  // ── Step 3: capture creative assets ──
  const r3 = runStep('Step 3/5 — Capture creative assets', 'browser:capture-assets', { BROWSER_ADS_FILE: csvFile });
  s.captured = num(r3.out, /Captured:\s+(\d+)/);
  s.inactive = num(r3.out, /Inactive\/skipped:\s+(\d+)/);
  s.noContainer = num(r3.out, /No container:\s+(\d+)/);
  s.qualitySkipped = num(r3.out, /Skipped \(no creative\):\s*(\d+)/);
  s.failed = num(r3.out, /Failed:\s+(\d+)/);
  if (r3.code !== 0) fail('asset capture (browser:capture-assets)', r3.code, 'Review the capture log above.');
  if (!fs.existsSync(assetsCsv)) fail('asset capture (browser:capture-assets)', 1, `Expected ${assetsCsv} was not created.`);

  // ── Step 4: validate enriched (.with-assets) CSV ──
  const r4 = runStep('Step 4/5 — Validate enriched .with-assets CSV', 'browser:validate', { BROWSER_ADS_FILE: assetsCsv });
  s.enrichedVerdict = verdict(r4.out);
  if (s.ready === 'n/a') s.ready = num(r4.out, /READY:\s+(\d+)/);
  if (s.needsReview === 'n/a') s.needsReview = num(r4.out, /NEEDS_REVIEW:\s+(\d+)/);
  if (r4.code !== 0) fail('enriched CSV validation (browser:validate)', r4.code, `Fix the rows flagged above in ${assetsCsv}.`);

  // ── Step 5: preview scoring ──
  const r5 = runStep('Step 5/5 — Preview scoring', 'browser:preview', { BROWSER_ADS_FILE: assetsCsv });
  s.previewVerdict = verdict(r5.out);
  s.scored = num(r5.out, /Successfully scored:\s+(\d+)/);
  s.visionHigh = num(r5.out, /HIGH[^\n]*?Vision[^\n]*?:\s+(\d+)/);
  s.manualMedium = num(r5.out, /MEDIUM[^\n]*?MANUAL[^\n]*?:\s+(\d+)/);
  const erroredMatch = r5.out.match(/Errored \(not scored\):\s+(\d+)/);
  s.errors = erroredMatch ? erroredMatch[1]! : '0';
  if (r5.code !== 0) fail('preview scoring (browser:preview)', r5.code, 'Review the scoring errors above.');

  // ── Workflow summary ──
  console.log(`\n${LINE}`);
  console.log('  ✓ WORKFLOW COMPLETE — SUMMARY');
  console.log(LINE);
  console.log(`  Competitor:                 ${COMPETITOR_NAME}`);
  console.log(`  CSV created:                ${s.csvCreated ? 'yes' : 'no'}  (${csvFile})`);
  console.log(`  Initial CSV validation:     ${s.initialVerdict}`);
  console.log(`  Assets captured:            ${s.captured}`);
  console.log(`  Enriched CSV:               ${assetsCsv}`);
  console.log(`  Enriched CSV validation:    ${s.enrichedVerdict}`);
  console.log(`  Preview scoring:            ${s.previewVerdict}`);
  console.log(SUB);
  console.log(`  READY rows:                 ${s.ready}`);
  console.log(`  NEEDS_REVIEW rows:          ${s.needsReview}`);
  console.log(`  Captured:                   ${s.captured}`);
  console.log(`  Inactive / skipped:         ${s.inactive}`);
  console.log(`  No container:               ${s.noContainer}`);
  console.log(`  Skipped (no creative):      ${s.qualitySkipped}`);
  console.log(`  Failed:                     ${s.failed}`);
  console.log(SUB);
  console.log(`  Successfully scored:        ${s.scored}`);
  console.log(`  Vision / HIGH:              ${s.visionHigh}`);
  console.log(`  Manual / MEDIUM:            ${s.manualMedium}`);
  console.log(`  Errors:                     ${s.errors}`);
  console.log(LINE);
  console.log('  No DB writes. No ingestion. Generated CSVs, logs, and creative');
  console.log('  assets are local only — do not commit them.');
  console.log(`${LINE}\n`);
}

main();
