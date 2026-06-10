/**
 * Run Client Browser Workflow  (Phase D)
 *
 * Client-level batch front-end. Given ONE CLIENT_ID, reads all competitors under
 * that client that have a stored metaPageId and runs the existing Phase C
 * (DB-driven one-competitor) workflow for each, ONE AT A TIME, then prints a
 * combined summary.
 *
 * Read-only against the DB (one client read + one competitor read). No writes,
 * no ingestion, no schema changes. Does not modify Phase A/B/C, capture, scoring,
 * ingestion, Prisma, or the dashboard UI. Generated CSVs / assets / logs are
 * local and must not be committed.
 *
 * Failure policy: competitors run sequentially. If one competitor's workflow
 * fails, it is recorded as failed and the batch CONTINUES to the next one (each
 * competitor has its own CSV/basename, so failures are isolated). The only hard
 * stop is a failed client/DB lookup. The process exits non-zero if ANY attempted
 * competitor failed, so automation can detect partial failure — but the full
 * combined summary is always printed first.
 *
 * Inputs (env):
 *   CLIENT_ID             (required)
 *   MAX_COMPETITORS       (default 2 — safety cap for batch size)
 *   FIRST_COMPETITOR_ID   (optional — moves this competitor to the front of the batch)
 *   MAX_ADS               (default 10, passed through to Phase C/B)
 *   HEADLESS              ('true' = headless; passed through)
 *   DEBUG_CAPTURE         ('true' = capture debug files; passed through)
 *
 * Example (Danish Design, HipVan first):
 *   set "CLIENT_ID=cmp23o629000n2fn6crin5u1n"
 *   set "FIRST_COMPETITOR_ID=cmpakdvd700017gems9wxfnet"
 *   set "MAX_COMPETITORS=2"
 *   set "MAX_ADS=10"
 *   set "HEADLESS=false"
 *   set "DEBUG_CAPTURE=true"
 *   npm run browser:workflow-client
 */

import { spawnSync } from 'child_process';
import { db } from '@/lib/db';

const LINE = '═'.repeat(64);
const SUB = '─'.repeat(64);

const CLIENT_ID = (process.env.CLIENT_ID ?? '').trim();
const FIRST_COMPETITOR_ID = (process.env.FIRST_COMPETITOR_ID ?? '').trim();
const MAX_COMPETITORS = Math.max(1, parseInt(process.env.MAX_COMPETITORS ?? '2', 10) || 2);
const MAX_ADS = (process.env.MAX_ADS ?? '10').trim();
const HEADLESS = (process.env.HEADLESS ?? '').trim();
const DEBUG_CAPTURE = (process.env.DEBUG_CAPTURE ?? '').trim();

// Same safe npm invocation as Phase B/C: shell stays false; on Windows go through
// the real executable cmd.exe (spawning npm.cmd directly with shell:false errors
// EINVAL on patched Node), on POSIX spawn npm directly.
const IS_WIN = process.platform === 'win32';

/** Parse an integer count from a labelled line; 0 if absent. */
function n(text: string, re: RegExp): number {
  const m = text.match(re);
  return m && m[1] !== undefined ? parseInt(m[1], 10) || 0 : 0;
}
/** Read a PASS/FAIL verdict for a labelled line. */
function verdictFor(text: string, label: string): string {
  const m = text.match(new RegExp(`${label}\\s+(PASS|FAIL|unknown)`));
  return m && m[1] !== undefined ? m[1] : '—';
}

type CompResult = {
  name: string;
  id: string;
  code: number;
  ready: number;
  needsReview: number;
  captured: number;
  inactive: number;
  noContainer: number;
  failedCap: number;
  scored: number;
  high: number;
  medium: number;
  errors: number;
  previewVerdict: string;
};

async function main(): Promise<void> {
  console.log(`\n${LINE}`);
  console.log('  Client Browser Workflow (Phase D)');
  console.log(LINE);

  if (!CLIENT_ID) {
    console.error('\n❌ CLIENT_ID is required.');
    console.error('   Example: set "CLIENT_ID=cmp23o629000n2fn6crin5u1n"');
    process.exit(1);
  }

  // ── Read-only DB lookup (the ONLY hard stop) ──
  const client = await db.client.findUnique({
    where: { id: CLIENT_ID },
    select: { id: true, name: true, industry: { select: { name: true } } },
  });
  if (!client) {
    console.error(`\n❌ No client found with id "${CLIENT_ID}".`);
    await db.$disconnect();
    process.exit(1);
  }

  const competitors = await db.competitor.findMany({
    where: { clientId: CLIENT_ID },
    select: { id: true, name: true, metaPageId: true },
    orderBy: { name: 'asc' },
  });

  const found = competitors.length;
  const withMeta = competitors.filter((c) => (c.metaPageId ?? '').trim() !== '');
  const skippedNoMeta = found - withMeta.length;

  if (withMeta.length === 0) {
    console.error(`\n❌ Client "${client.name}" has no competitors with a stored Meta page ID.`);
    console.error(`   (${found} competitor(s) found, none with metaPageId.) Set page IDs in the`);
    console.error('   competitor Meta config first, then re-run.');
    await db.$disconnect();
    process.exit(1);
  }

  // ── Batch order: optional FIRST_COMPETITOR_ID to front, rest alphabetical ──
  let ordered = [...withMeta];
  if (FIRST_COMPETITOR_ID) {
    const idx = ordered.findIndex((c) => c.id === FIRST_COMPETITOR_ID);
    if (idx > 0) {
      const [first] = ordered.splice(idx, 1);
      ordered = [first!, ...ordered];
    }
  }
  const batch = ordered.slice(0, MAX_COMPETITORS);
  const cappedOut = withMeta.length - batch.length;

  // ── Plan ──
  console.log(`  Client:                ${client.name}`);
  console.log(`  Industry:              ${client.industry?.name ?? '(none)'}`);
  console.log(`  Client ID:             ${client.id}`);
  console.log(`  Competitors found:     ${found}`);
  console.log(`  With metaPageId:       ${withMeta.length}`);
  console.log(`  Skipped (no metaPageId): ${skippedNoMeta}`);
  console.log(`  MAX_COMPETITORS:       ${MAX_COMPETITORS}`);
  console.log(`  Attempting this run:   ${batch.length}${cappedOut > 0 ? ` (${cappedOut} more capped out)` : ''}`);
  console.log(`  Max ads / competitor:  ${MAX_ADS}`);
  console.log(`  Headless:              ${HEADLESS === 'true' ? 'yes' : 'no'}`);
  console.log(`  Debug capture:         ${DEBUG_CAPTURE === 'true' ? 'on' : 'off'}`);
  console.log(SUB);
  console.log('  Batch order:');
  batch.forEach((c, i) => console.log(`    ${i + 1}. ${c.name}  (${c.id})`));

  // DB work is done — release before the (long) sequential child workflows.
  await db.$disconnect();

  const cmd = IS_WIN ? 'cmd.exe' : 'npm';
  const baseArgs = IS_WIN ? ['/c', 'npm', 'run', 'browser:workflow-db-one'] : ['run', 'browser:workflow-db-one'];

  const results: CompResult[] = [];

  // ── Sequential per-competitor runs (continue on failure) ──
  for (let i = 0; i < batch.length; i++) {
    const comp = batch[i]!;
    console.log(`\n${LINE}`);
    console.log(`  ▶  Competitor ${i + 1}/${batch.length}: ${comp.name}  (${comp.id})`);
    console.log(`${LINE}`);

    const res = spawnSync(cmd, baseArgs, {
      env: {
        ...process.env,
        COMPETITOR_ID: comp.id,
        MAX_ADS,
        HEADLESS,
        DEBUG_CAPTURE,
      },
      encoding: 'utf-8',
      shell: false,
      maxBuffer: 128 * 1024 * 1024,
    });

    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (out.trim()) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
    if (res.error) console.error(`  ⚠ spawn error: ${res.error.message}`);
    const code = typeof res.status === 'number' ? res.status : 1;

    const r: CompResult = {
      name: comp.name,
      id: comp.id,
      code,
      ready: n(out, /READY rows:\s+(\d+)/),
      needsReview: n(out, /NEEDS_REVIEW rows:\s+(\d+)/),
      captured: n(out, /(?:^|\n)\s*Captured:\s+(\d+)/),
      inactive: n(out, /Inactive \/ skipped:\s+(\d+)/),
      noContainer: n(out, /No container:\s+(\d+)/),
      failedCap: n(out, /(?:^|\n)\s*Failed:\s+(\d+)/),
      scored: n(out, /Successfully scored:\s+(\d+)/),
      high: n(out, /Vision \/ HIGH:\s+(\d+)/),
      medium: n(out, /Manual \/ MEDIUM:\s+(\d+)/),
      errors: n(out, /Errors:\s+(\d+)/),
      previewVerdict: verdictFor(out, 'Preview scoring:'),
    };
    results.push(r);

    console.log(`\n${SUB}`);
    console.log(`  ${code === 0 ? '✓' : '✗'}  ${comp.name}: ${code === 0 ? 'COMPLETED' : `FAILED (exit ${code})`} · READY ${r.ready} · captured ${r.captured} · scored ${r.scored} · preview ${r.previewVerdict}`);
    console.log(SUB);
  }

  // ── Combined summary ──
  const completed = results.filter((r) => r.code === 0).length;
  const failed = results.filter((r) => r.code !== 0).length;
  const sum = (key: keyof CompResult) => results.reduce((acc, r) => acc + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0);

  console.log(`\n${LINE}`);
  console.log('  ✓ CLIENT BATCH COMPLETE — COMBINED SUMMARY');
  console.log(LINE);
  console.log(`  Client:                        ${client.name}`);
  console.log(`  Competitors found:             ${found}`);
  console.log(`  Competitors with metaPageId:   ${withMeta.length}`);
  console.log(`  Skipped (no metaPageId):       ${skippedNoMeta}`);
  console.log(`  Competitors attempted:         ${batch.length}${cappedOut > 0 ? ` (${cappedOut} capped out by MAX_COMPETITORS)` : ''}`);
  console.log(`  Competitors completed:         ${completed}`);
  console.log(`  Competitors failed:            ${failed}`);
  console.log(SUB);
  console.log(`  Total READY rows:              ${sum('ready')}`);
  console.log(`  Total NEEDS_REVIEW rows:       ${sum('needsReview')}`);
  console.log(`  Total captured:                ${sum('captured')}`);
  console.log(`  Total inactive / skipped:      ${sum('inactive')}`);
  console.log(`  Total no-container:            ${sum('noContainer')}`);
  console.log(`  Total failed captures:         ${sum('failedCap')}`);
  console.log(`  Total successfully scored:     ${sum('scored')}`);
  console.log(`  Total Vision / HIGH:           ${sum('high')}`);
  console.log(`  Total Manual / MEDIUM:         ${sum('medium')}`);
  console.log(`  Total errors:                  ${sum('errors')}`);
  console.log(SUB);
  console.log('  Per competitor:');
  for (const r of results) {
    console.log(`    ${r.code === 0 ? '✓' : '✗'} ${r.name}: READY ${r.ready}, captured ${r.captured}, scored ${r.scored}, HIGH ${r.high}, errors ${r.errors}${r.code === 0 ? '' : ` (exit ${r.code})`}`);
  }
  console.log(LINE);
  console.log('  Read-only DB access. No DB writes. No ingestion.');
  console.log('  Generated CSVs, logs, and creative assets are local — do not commit.');
  console.log(`${LINE}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err: unknown) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  try { await db.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
