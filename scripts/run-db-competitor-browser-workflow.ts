/**
 * Run DB-Competitor Browser Workflow  (Phase C)
 *
 * DB-driven front-end for the Phase B one-competitor workflow. Instead of
 * manually setting COMPETITOR_NAME / META_PAGE_ID / META_AD_LIBRARY_URL, this
 * reads ONE competitor from the database by COMPETITOR_ID, derives the env, and
 * delegates to the existing `npm run browser:workflow-one` unchanged.
 *
 * It is READ-ONLY against the DB (a single findUnique). It performs no writes,
 * no ingestion, and no schema changes. It does not modify Phase A, Phase B,
 * capture, scoring, ingestion, Prisma, the dashboard UI, or any DB data. The
 * generated CSVs / assets / logs are local and must not be committed.
 *
 * Inputs (env):
 *   COMPETITOR_ID   (required)
 *   MAX_ADS         (default 10, passed through to Phase B)
 *   HEADLESS        ('true' = headless; passed through)
 *   DEBUG_CAPTURE   ('true' = capture debug files; passed through)
 *
 * Example:
 *   set "COMPETITOR_ID=cmpakdvd700017gems9wxfnet"
 *   set "MAX_ADS=10"
 *   set "HEADLESS=false"
 *   set "DEBUG_CAPTURE=true"
 *   npm run browser:workflow-db-one
 */

import { spawnSync } from 'child_process';
import { db } from '@/lib/db';

const LINE = '═'.repeat(64);
const SUB = '─'.repeat(64);

const COMPETITOR_ID = (process.env.COMPETITOR_ID ?? '').trim();

/** Filesystem-safe slug: lowercase, alnum + hyphen only, collapsed, trimmed. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    || 'competitor';
}

// Invoke npm the same safe way as Phase B: shell stays false; on Windows spawn
// the real executable cmd.exe (spawning npm.cmd directly with shell:false errors
// EINVAL on patched Node), on POSIX spawn npm directly.
const IS_WIN = process.platform === 'win32';

async function main(): Promise<void> {
  console.log(`\n${LINE}`);
  console.log('  DB-Competitor Browser Workflow (Phase C)');
  console.log(LINE);

  if (!COMPETITOR_ID) {
    console.error('\n❌ COMPETITOR_ID is required.');
    console.error('   Example: set "COMPETITOR_ID=cmpakdvd700017gems9wxfnet"');
    process.exit(1);
  }

  // ── Read-only DB lookup ──
  const competitor = await db.competitor.findUnique({
    where: { id: COMPETITOR_ID },
    select: {
      id: true,
      name: true,
      metaPageId: true,
      facebookPageUrl: true,
      client: { select: { name: true } },
      industry: { select: { name: true } },
    },
  });

  if (!competitor) {
    console.error(`\n❌ No competitor found with id "${COMPETITOR_ID}".`);
    console.error('   Check the id against the competitors in your database.');
    await db.$disconnect();
    process.exit(1);
  }

  const metaPageId = (competitor.metaPageId ?? '').trim();
  if (!metaPageId) {
    console.error(`\n❌ Competitor "${competitor.name}" has no Meta page ID.`);
    console.error('   Set it in the competitor Meta config first, then re-run.');
    if (competitor.facebookPageUrl) {
      console.error(`   (A Facebook page URL is stored — ${competitor.facebookPageUrl} — but it has no`);
      console.error('    numeric page id, so it cannot be used to query the Ad Library.)');
    }
    await db.$disconnect();
    process.exit(1);
  }

  // ── Derive a safe output basename: <slug>-<shortId>-browser-collected-ads ──
  const shortId = competitor.id.slice(0, 8);
  const outputBasename = `${slugify(competitor.name)}-${shortId}-browser-collected-ads`;

  // Pass-through controls (default to Phase B's own defaults if unset)
  const maxAds = (process.env.MAX_ADS ?? '10').trim();
  const headless = (process.env.HEADLESS ?? '').trim();
  const debugCapture = (process.env.DEBUG_CAPTURE ?? '').trim();

  // ── Phase C header ──
  console.log(`  Competitor:      ${competitor.name}`);
  console.log(`  Competitor ID:   ${competitor.id}`);
  console.log(`  Client:          ${competitor.client?.name ?? '(none)'}`);
  console.log(`  Industry:        ${competitor.industry?.name ?? '(none)'}`);
  console.log(`  Meta page ID:    ${metaPageId}`);
  console.log(`  Output basename: ${outputBasename}`);
  console.log(`  Max ads:         ${maxAds}`);
  console.log(`  Headless:        ${headless === 'true' ? 'yes' : 'no'}`);
  console.log(`  Debug capture:   ${debugCapture === 'true' ? 'on' : 'off'}`);
  console.log(SUB);
  console.log('  Read-only DB lookup complete. Delegating to Phase B (browser:workflow-one)…');

  // DB work is done — release the connection before the (long) child workflow.
  await db.$disconnect();

  // ── Delegate to Phase B, unchanged ──
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    COMPETITOR_NAME: competitor.name,
    META_PAGE_ID: metaPageId,
    META_AD_LIBRARY_URL: '', // cleared so Phase A builds the URL from the DB page id
    OUTPUT_BASENAME: outputBasename,
    MAX_ADS: maxAds,
    HEADLESS: headless,
    DEBUG_CAPTURE: debugCapture,
  };

  const cmd = IS_WIN ? 'cmd.exe' : 'npm';
  const args = IS_WIN ? ['/c', 'npm', 'run', 'browser:workflow-one'] : ['run', 'browser:workflow-one'];
  const res = spawnSync(cmd, args, {
    env: childEnv,
    stdio: 'inherit', // stream Phase B's full output (incl. its summary) live
    shell: false,
  });

  if (res.error) {
    console.error(`\n❌ Failed to launch Phase B workflow: ${res.error.message}`);
    process.exit(1);
  }
  const code = typeof res.status === 'number' ? res.status : 1;

  console.log(`\n${LINE}`);
  if (code === 0) {
    console.log(`  ✓ Phase C complete for ${competitor.name} (${competitor.id}).`);
  } else {
    console.log(`  ❌ Phase C: Phase B workflow exited with code ${code} for ${competitor.name}.`);
  }
  console.log('  Read-only DB access. No DB writes. No ingestion.');
  console.log('  Generated CSVs, logs, and creative assets are local — do not commit.');
  console.log(`${LINE}\n`);

  process.exit(code);
}

main().catch(async (err: unknown) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  try { await db.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
