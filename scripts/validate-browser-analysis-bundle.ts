/**
 * Browser Analysis Bundle — standalone validator  (Phase 1)
 *
 * Makes NO Anthropic call, NO Vision call, NO browser call, NO database or Prisma
 * access. It reads the bundle plus the local files its checksums reference.
 *
 * Usage:
 *   npm run browser:bundle:validate -- <bundle-path>
 *   npm run browser:bundle:validate -- <bundle-path> --no-file-checks
 */

import { loadBundle } from '@/lib/analysis/browserAnalysisBundle';

const KNOWN_FLAGS = ['--no-file-checks'];

export function parseArgs(argv: string[]): { ok: true; bundlePath: string; skipFiles: boolean } | { ok: false; error: string } {
  const args = argv.filter((a) => a !== '--');
  const flags = args.filter((a) => a.startsWith('-'));
  const positionals = args.filter((a) => !a.startsWith('-'));

  for (const f of flags) if (!KNOWN_FLAGS.includes(f)) return { ok: false, error: `unknown flag "${f}"` };
  if (new Set(flags).size !== flags.length) return { ok: false, error: 'duplicate flag supplied' };
  if (positionals.length === 0) return { ok: false, error: 'no bundle path supplied' };
  if (positionals.length > 1) return { ok: false, error: `expected exactly one bundle path, got ${positionals.length}` };

  return { ok: true, bundlePath: positionals[0]!, skipFiles: flags.includes('--no-file-checks') };
}

function main(): void {
  const LINE = '═'.repeat(63);
  console.log(`\n${LINE}`);
  console.log('  Browser Analysis Bundle — Validator');
  console.log(LINE);
  console.log('  No Anthropic call.  No browser.  No database.  No Prisma.');
  console.log(LINE);

  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`\n❌ ${parsed.error}`);
    console.error('   Usage: npm run browser:bundle:validate -- <bundle-path> [--no-file-checks]');
    process.exit(2);
  }
  const { bundlePath, skipFiles } = parsed;

  const result = loadBundle(bundlePath, { checkFiles: !skipFiles });
  if (!result.ok) {
    console.log(`\n  Bundle: ${bundlePath}`);
    console.log(`\n  ❌ INVALID — ${result.errors.length} validation failure(s):`);
    for (const e of result.errors) console.log(`     • ${e}`);
    console.log('');
    process.exit(1);
  }

  const b = result.bundle;
  // The headline verdict must never imply integrity that was not checked.
  console.log(`\n  ${skipFiles
    ? '⚠  STRUCTURALLY VALID — SOURCE AND ASSET INTEGRITY NOT VERIFIED'
    : '✓ VALID — STRUCTURE, SOURCE AND ASSET INTEGRITY VERIFIED'}`);
  console.log(`  Bundle path:        ${bundlePath}`);
  console.log(`  Schema version:     ${b.schema_version}`);
  console.log(`  Created at:         ${b.created_at}`);
  console.log(`  Prompt version:     ${b.prompt_version}`);
  console.log(`  Planner version:    ${b.planner_version}`);
  console.log(`  Analysis model:     ${b.analysis_model ?? '(none — no Vision used)'}`);
  console.log(`  Video frame limit:  ${b.ai_video_max_frames}`);
  console.log('  ── Source identity ──');
  console.log(`  Source CSV:         ${b.source_csv_path}`);
  console.log(`  Source SHA-256:     ${b.source_csv_sha256}`);
  console.log(`  Verified sidecar:   ${b.verified_meta_path ?? '(none)'}`);
  if (b.verified_meta_sha256) console.log(`  Sidecar SHA-256:    ${b.verified_meta_sha256}`);
  console.log(`  File checks:        ${skipFiles ? 'SKIPPED (--no-file-checks)' : 'performed'}`);
  console.log('  ── Row counts ──');
  console.log(`  Input rows:         ${b.counts.input_rows}`);
  console.log(`  Selected rows:      ${b.counts.selected_rows}`);
  console.log(`  SUCCESS:            ${b.counts.success}`);
  console.log(`  REVIEW:             ${b.counts.review}`);
  console.log(`  SKIPPED:            ${b.counts.skipped}`);
  console.log(`  ERROR:              ${b.counts.failed}`);
  console.log('  ── Selection ──');
  console.log(`  Selected ad IDs (${b.selected_ad_ids.length}): ${b.selected_ad_ids.join(', ') || '(none)'}`);
  console.log(`  Excluded ad IDs (${b.excluded_ad_ids.length}): ${b.excluded_ad_ids.join(', ') || '(none)'}`);
  console.log(`\n${LINE}\n`);
}

if (require.main === module) main();
