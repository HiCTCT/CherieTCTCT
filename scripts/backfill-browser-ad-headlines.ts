/**
 * Backfill / clean polluted browser-collected ad HEADLINES  (Phase H.2)
 *
 * Older browser-collected ads were stored before create-csv's cleanMetaHeadlineText
 * existed (or were skipped as duplicates), so their headline still carries the glued
 * display-URL prefix and trailing CTA label, e.g.:
 *   "CASTLERY.COMMori Performance Fabric 3 Seater Sofa | Castlery Singapore Shop Now"
 * This script cleans ONLY the headline field on existing rows.
 *
 * It touches NOTHING else: no analysis, scores, qualification, relations, captured
 * assets, or any other field. No inserts, no deletes. Only `headline` is updated,
 * and only on rows whose headline is actually polluted (cleaning changes it to a
 * non-empty value). Rows with clean headlines, or where cleaning would empty the
 * headline, are skipped.
 *
 * SAFETY: dry-run by default. Live writes require ALL THREE flags:
 *   BROWSER_DRY_RUN=false
 *   BROWSER_HEADLINE_BACKFILL_WRITE=true
 *   BROWSER_HEADLINE_BACKFILL_CONFIRM_DB_WRITES=I_UNDERSTAND
 *
 * Usage:
 *   npm run browser:backfill-headlines                         (dry-run)
 */

import { PrismaClient } from '@prisma/client';

const AD_SOURCE = 'browser_collected';

// Known brand names whose internal lowercase→uppercase boundary (HipVan, BoConcept)
// or dot (W.Atelier) must survive the spacing cleanup. Matched case-sensitively so
// an uppercase display URL (CASTLERY.COM) — already stripped — is never confused
// with the brand. Add more terms here as needed.
const PROTECTED_BRANDS = ['W.Atelier', 'HipVan', 'BoConcept', 'Castlery'];

// Mask delimiter: a NUL control character. It can never appear in a real headline,
// so the placeholder (NUL + index + NUL) never collides with real digits such as
// "3 Seater" or "10% ", and the spacing rules below never touch it.
const MASK = String.fromCharCode(0);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Clean a polluted headline: strip a leading display-URL/domain, strip a trailing
 * CTA-button label, then conservatively re-space glued words — without disturbing
 * numbers, %, URLs, all-caps acronyms (TOTO), or protected brand names.
 */
function cleanMetaHeadlineText(rawHeadline: string): string {
  let h = (rawHeadline ?? '').replace(/\s+/g, ' ').trim();

  // 1. Leading display URL / domain (case-insensitive; only strip when the char
  //    after the TLD is NOT a lowercase letter, so a real boundary is cut while a
  //    longer word like ".community" is left intact).
  const domainMatch = h.match(/^\s*(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]*?\.(?:com\.sg|com|sg|org|net)/i);
  if (domainMatch) {
    const after = h.slice(domainMatch[0].length);
    if (after === '' || !/^[a-z]/.test(after)) {
      h = after.trim();
    }
  }

  // 2. Trailing CTA-button label (multi-word labels first).
  const CTAS = [
    'Send message', 'Learn More', 'See details', 'Contact us', 'Get Quote',
    'Apply Now', 'Sign Up', 'Shop Now', 'Book now', 'Subscribe', 'Download', 'WhatsApp',
  ];
  for (const cta of CTAS) {
    const re = new RegExp('\\s*' + escapeRegExp(cta) + '\\s*$', 'i');
    if (re.test(h)) { h = h.replace(re, '').trim(); break; }
  }

  // 3. Conservative spacing cleanup.
  // 3-mask: protect brand terms BEFORE spacing so their own internal boundaries
  //         (HipVan → Hip Van) are not split; restored at the end.
  const stash: string[] = [];
  for (const term of PROTECTED_BRANDS) {
    const re = new RegExp(escapeRegExp(term), 'g');
    h = h.replace(re, () => { stash.push(term); return MASK + (stash.length - 1) + MASK; });
  }

  // 3a. Specific known brand glue.
  h = h.replace(/\bHouseof([A-Z])/g, 'House of $1');
  // 3b. Space after sentence punctuation between a LOWERCASE letter and another
  //     letter ("Guaranteed.This" → "Guaranteed. This"). The lowercase pre-check
  //     protects dotted acronyms (U.S.A) and decimals (3.5).
  h = h.replace(/([a-z])([.!?])(?=[A-Za-z])/g, '$1$2 ');
  // 3c. Space at lowercase→uppercase glue boundaries ("seasonDiscover" →
  //     "season Discover", "LivingAt" → "Living At"). All-caps runs (TOTO),
  //     digit→upper boundaries, and masked brand terms are left untouched.
  h = h.replace(/([a-z])([A-Z])/g, '$1 $2');

  // 3-restore: put the protected brand terms back.
  h = h.replace(new RegExp(MASK + '(\\d+)' + MASK, 'g'), (_m, n) => stash[Number(n)] ?? '');

  return h.replace(/\s+/g, ' ').trim();
}

async function main(): Promise<void> {
  const LINE = '═'.repeat(64);

  const dryRun = process.env.BROWSER_DRY_RUN !== 'false';
  const writeFlag = process.env.BROWSER_HEADLINE_BACKFILL_WRITE === 'true';
  const confirmFlag = process.env.BROWSER_HEADLINE_BACKFILL_CONFIRM_DB_WRITES;
  const liveWrite = !dryRun && writeFlag && confirmFlag === 'I_UNDERSTAND';

  console.log(`\n${LINE}`);
  console.log('  Backfill browser-collected ad headlines (Phase H.2)');
  console.log(LINE);
  console.log(`  Mode:        ${liveWrite ? '⚠  LIVE WRITE MODE — DB writes ACTIVE' : 'DRY RUN — no DB writes'}`);
  console.log(`  Ad source:   ${AD_SOURCE}`);
  console.log(LINE);

  if (!dryRun && !liveWrite) {
    console.error('\n❌ Live write requested but not all 3 confirmation flags are set:');
    console.error(`   BROWSER_DRY_RUN=false                                      ${!dryRun ? '✓' : '✗ not set'}`);
    console.error(`   BROWSER_HEADLINE_BACKFILL_WRITE=true                       ${writeFlag ? '✓' : '✗ missing or wrong'}`);
    console.error(`   BROWSER_HEADLINE_BACKFILL_CONFIRM_DB_WRITES=I_UNDERSTAND   ${confirmFlag === 'I_UNDERSTAND' ? '✓' : '✗ missing or wrong'}`);
    console.error('\n   Re-run with all 3 flags, or remove BROWSER_DRY_RUN=false to stay in dry-run.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const ads = await prisma.ad.findMany({
      where: { adSource: AD_SOURCE, NOT: { headline: null } },
      select: { id: true, metaAdId: true, headline: true },
      orderBy: { createdAt: 'asc' },
    });

    let cleaned = 0;
    let skippedNoChange = 0;
    let skippedEmpty = 0;
    let updated = 0;

    for (const ad of ads) {
      const before = (ad.headline ?? '').trim();
      const after = cleanMetaHeadlineText(before);

      if (after === before) { skippedNoChange++; continue; }      // not polluted — leave it
      if (after === '') {                                          // would empty the headline — never do that
        skippedEmpty++;
        console.log(`\n  ○ ${ad.metaAdId ?? ad.id}  SKIPPED (cleaned headline would be empty)`);
        console.log(`      before: ${before}`);
        continue;
      }

      cleaned++;
      console.log(`\n  ${liveWrite ? '✓' : '→'} ${ad.metaAdId ?? ad.id}  ${liveWrite ? 'UPDATED' : 'WOULD UPDATE'}`);
      console.log(`      before: ${before}`);
      console.log(`      after:  ${after}`);

      if (liveWrite) {
        await prisma.ad.update({ where: { id: ad.id }, data: { headline: after } });
        updated++;
      }
    }

    console.log(`\n${LINE}`);
    console.log('  SUMMARY');
    console.log(LINE);
    console.log(`  Mode:                       ${liveWrite ? 'LIVE WRITE' : 'DRY RUN'}`);
    console.log(`  browser_collected ads read: ${ads.length}`);
    console.log(`  Polluted headlines found:   ${cleaned}`);
    console.log(`  ${liveWrite ? 'Headlines updated:         ' : 'Would update:              '} ${liveWrite ? updated : cleaned}`);
    console.log(`  Skipped (already clean):    ${skippedNoChange}`);
    console.log(`  Skipped (would be empty):   ${skippedEmpty}`);
    console.log(LINE);
    console.log('  Only the headline field is ever changed. No analysis, scores,');
    console.log('  qualification, relations, captured assets, inserts, or deletes.');
    if (!liveWrite) {
      console.log('  DRY RUN — nothing written. To write, set all 3 flags:');
      console.log('    BROWSER_DRY_RUN=false  BROWSER_HEADLINE_BACKFILL_WRITE=true  BROWSER_HEADLINE_BACKFILL_CONFIRM_DB_WRITES=I_UNDERSTAND');
    }
    console.log(`${LINE}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
