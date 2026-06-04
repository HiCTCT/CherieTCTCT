/**
 * Competitor Benchmark Backfill  (conservative, separate from ingestion)
 *
 * Populates the competitor benchmark fields for ads that ALREADY exist in the DB
 * and already have an AdAnalysis, by computing the benchmark from the stored
 * analysis. It does NOT call Vision/Anthropic and does NOT re-derive any analysis
 * scores — it only reads what is already stored and writes the benchmark fields.
 *
 * DEFAULT MODE: DRY RUN — no database writes.
 *
 * creativeSource policy (conservative — see decision log):
 *   The original ingestion did not store creativeSource, and the existing rows'
 *   AdAnalysis predates the final asset/Vision workflow. We therefore NEVER infer
 *   ASSET from DB text. Source is decided from the stored creativeAnalysis only:
 *     - machine-fallback sentinel present  -> FALLBACK  (evidence NONE,   confidence LOW)
 *     - otherwise (real creative text)      -> MANUAL    (evidence MANUAL, confidence MEDIUM)
 *   To get true ASSET/HIGH scores, re-ingest with Vision (a separate path).
 *
 * Usage (dry-run, default):
 *   set COMPETITOR_ID=<id>&& npm run benchmark:backfill
 *
 * Live write requires ALL THREE flags:
 *   BENCHMARK_BACKFILL_DRY_RUN=false
 *   BENCHMARK_BACKFILL_WRITE=true
 *   BENCHMARK_BACKFILL_CONFIRM_DB_WRITES=I_UNDERSTAND
 *
 * Other env:
 *   COMPETITOR_ID=<id>                  — restrict to one competitor (optional)
 *   BENCHMARK_BACKFILL_RESCORE=true     — also recompute rows already scored
 *                                         (default: only fill rows where
 *                                          competitorBenchmarkScore IS NULL)
 *
 * NEVER writes: score, qualified, finalVerdict, copyScore, headlineScore,
 * creativeScore, aida*Score, primaryCopy, headline, description, adSource.
 */

import { PrismaClient } from '@prisma/client';

import { scoreCompetitorBenchmarkAd } from '@/lib/analysis/competitorScoring';
import type { AnalysisOutput } from '@/lib/analysis/types';
import type { CreativeSource } from '@/lib/analysis/creativeAssetAnalyser';

// ─── Conservative source detection (stored AdAnalysis only; never ASSET) ────────

function detectCreativeSource(creativeAnalysis: string | null | undefined): CreativeSource {
  const t = (creativeAnalysis ?? '').toLowerCase();
  if (t.includes('machine-scored') || t.includes('no creative description was provided')) {
    return 'FALLBACK';
  }
  return 'MANUAL';
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function fmtScore(n: number | null | undefined): string {
  return n === null || n === undefined ? 'null' : n.toFixed(2);
}

type Decision = 'WOULD_UPDATE' | 'SKIP_ALREADY_SCORED' | 'SKIP_MISSING_ANALYSIS' | 'SKIP_MISSING_SCORES';

const DECISION_LABEL: Record<Decision, string> = {
  WOULD_UPDATE:           'WOULD UPDATE',
  SKIP_ALREADY_SCORED:    'SKIP already scored',
  SKIP_MISSING_ANALYSIS:  'SKIP missing analysis',
  SKIP_MISSING_SCORES:    'SKIP missing scores',
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const LINE = '═'.repeat(72);
  const DIV  = '─'.repeat(72);

  const dryRun      = process.env.BENCHMARK_BACKFILL_DRY_RUN !== 'false';
  const writeFlag   = process.env.BENCHMARK_BACKFILL_WRITE === 'true';
  const confirmFlag = process.env.BENCHMARK_BACKFILL_CONFIRM_DB_WRITES;
  const liveWrite   = !dryRun && writeFlag && confirmFlag === 'I_UNDERSTAND';
  const rescore     = process.env.BENCHMARK_BACKFILL_RESCORE === 'true';
  const competitorId = process.env.COMPETITOR_ID?.trim() || undefined;

  console.log(`\n${LINE}`);
  console.log('  Competitor Benchmark Backfill (conservative)');
  console.log(LINE);
  console.log(`  Mode:          ${dryRun ? 'DRY RUN — no DB writes' : '⚠  LIVE WRITE MODE — DB writes ACTIVE'}`);
  console.log(`  Competitor:    ${competitorId ?? 'ALL competitors'}`);
  console.log(`  Rescore:       ${rescore ? 'ON (recompute already-scored rows)' : 'OFF (backfill NULL benchmark only)'}`);
  console.log(`  Source policy: conservative (FALLBACK or MANUAL only — never ASSET)`);
  if (dryRun) {
    console.log('  DB writes:     0');
    console.log('  To enable live writes, set all 3 flags:');
    console.log('    BENCHMARK_BACKFILL_DRY_RUN=false');
    console.log('    BENCHMARK_BACKFILL_WRITE=true');
    console.log('    BENCHMARK_BACKFILL_CONFIRM_DB_WRITES=I_UNDERSTAND');
  }
  console.log(LINE);

  // Guard: live write requires all three flags.
  if (!dryRun && !liveWrite) {
    console.error('\n❌ Live write mode requires all 3 flags set correctly:');
    console.error(`   BENCHMARK_BACKFILL_DRY_RUN=false                         ${!dryRun ? '✓' : '✗ not set'}`);
    console.error(`   BENCHMARK_BACKFILL_WRITE=true                            ${writeFlag ? '✓' : '✗ missing or wrong'}`);
    console.error(`   BENCHMARK_BACKFILL_CONFIRM_DB_WRITES=I_UNDERSTAND        ${confirmFlag === 'I_UNDERSTAND' ? '✓' : '✗ missing or wrong'}`);
    console.error('\n   Re-run with all 3 flags, or remove BENCHMARK_BACKFILL_DRY_RUN=false to stay in dry-run.');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    // Only ads that already have an AdAnalysis.
    const ads = await prisma.ad.findMany({
      where: {
        ...(competitorId ? { competitorId } : {}),
        analysis: { isNot: null },
      },
      select: {
        id: true,
        metaAdId: true,
        competitorBenchmarkScore: true,
        benchmarkTier: true,
        benchmarkConfidence: true,
        evidenceSource: true,
        creativeSource: true,
        analysis: {
          select: {
            creativeAnalysis: true,
            copyScore: true,
            creativeScore: true,
            aidaAttentionScore: true,
            aidaInterestScore: true,
            aidaDesireScore: true,
            aidaActionScore: true,
          },
        },
      },
      orderBy: { competitorBenchmarkScore: 'desc' },
    });

    console.log(`\n  READY rows (have AdAnalysis): ${ads.length}\n`);

    const counts: Record<Decision, number> = {
      WOULD_UPDATE: 0, SKIP_ALREADY_SCORED: 0, SKIP_MISSING_ANALYSIS: 0, SKIP_MISSING_SCORES: 0,
    };
    const tierCounts: Record<string, number> = {};
    const confCounts: Record<string, number> = {};
    let written = 0;

    for (const ad of ads) {
      const an = ad.analysis;

      // Decision: missing analysis (defensive — query already filters)
      if (!an) {
        counts.SKIP_MISSING_ANALYSIS += 1;
        console.log(`  ○ ${ad.metaAdId ?? ad.id}  ${DECISION_LABEL.SKIP_MISSING_ANALYSIS}`);
        continue;
      }

      // Decision: already scored and not rescoring
      if (ad.competitorBenchmarkScore != null && !rescore) {
        counts.SKIP_ALREADY_SCORED += 1;
        console.log(`  ○ ${ad.metaAdId ?? ad.id}  ${DECISION_LABEL.SKIP_ALREADY_SCORED} (benchmark=${fmtScore(ad.competitorBenchmarkScore)})`);
        continue;
      }

      // Decision: required stored scores must be present to compute a trustworthy benchmark
      const required = [
        an.aidaAttentionScore, an.aidaInterestScore, an.aidaDesireScore, an.aidaActionScore,
        an.creativeScore, an.copyScore,
      ];
      if (required.some((v) => v === null || v === undefined)) {
        counts.SKIP_MISSING_SCORES += 1;
        console.log(`  ○ ${ad.metaAdId ?? ad.id}  ${DECISION_LABEL.SKIP_MISSING_SCORES}`);
        continue;
      }

      // Reconstruct only the inputs the benchmark scorer reads.
      const analysisShape = {
        aidaScores: {
          attention: an.aidaAttentionScore as number,
          interest:  an.aidaInterestScore as number,
          desire:    an.aidaDesireScore as number,
          action:    an.aidaActionScore as number,
        },
        creativeScore: an.creativeScore as number,
        copyScore:     an.copyScore as number,
      } as unknown as AnalysisOutput;

      const source = detectCreativeSource(an.creativeAnalysis);
      const bm = scoreCompetitorBenchmarkAd(analysisShape, source);

      counts.WOULD_UPDATE += 1;
      tierCounts[bm.tierToken] = (tierCounts[bm.tierToken] ?? 0) + 1;
      confCounts[bm.confidence] = (confCounts[bm.confidence] ?? 0) + 1;

      console.log(`  ✓ ${ad.metaAdId ?? ad.id}  ${liveWrite ? 'UPDATING' : DECISION_LABEL.WOULD_UPDATE}`);
      console.log(`      ad.id: ${ad.id}`);
      console.log(`      benchmarkScore:  ${fmtScore(ad.competitorBenchmarkScore)}  →  ${bm.benchmarkScore.toFixed(2)}`);
      console.log(`      benchmarkTier:   ${ad.benchmarkTier ?? 'null'}  →  ${bm.tierToken}`);
      console.log(`      confidence:      ${ad.benchmarkConfidence ?? 'null'}  →  ${bm.confidence}`);
      console.log(`      evidenceSource:  ${ad.evidenceSource ?? 'null'}  →  ${bm.evidenceToken}`);
      console.log(`      creativeSource:  ${ad.creativeSource ?? 'null'}  →  ${source}`);

      if (liveWrite) {
        await prisma.$transaction(async (tx) => {
          // Ad: ONLY the six benchmark fields. Nothing else.
          await tx.ad.update({
            where: { id: ad.id },
            data: {
              competitorBenchmarkScore: bm.benchmarkScore,
              benchmarkTier:            bm.tierToken,
              benchmarkConfidence:      bm.confidence,
              evidenceSource:           bm.evidenceToken,
              creativeSource:           source,
              benchmarkScoredAt:        new Date(),
            },
          });
          // AdAnalysis: ONLY the two detail fields. Nothing else.
          await tx.adAnalysis.update({
            where: { adId: ad.id },
            data: {
              recommendedUse:         bm.recommendedUse,
              benchmarkBreakdownJson: JSON.stringify({ formula: bm.formula, breakdown: bm.breakdown }),
            },
          });
        });
        written += 1;
      }
    }

    // ── Summary ──
    console.log(`\n${DIV}`);
    console.log('  SUMMARY — by decision');
    console.log(DIV);
    console.log(`  WOULD UPDATE${liveWrite ? ' / UPDATED' : ''}:   ${counts.WOULD_UPDATE}`);
    console.log(`  SKIP already scored:    ${counts.SKIP_ALREADY_SCORED}`);
    console.log(`  SKIP missing analysis:  ${counts.SKIP_MISSING_ANALYSIS}`);
    console.log(`  SKIP missing scores:    ${counts.SKIP_MISSING_SCORES}`);
    if (liveWrite) console.log(`  Rows written:           ${written}`);

    console.log(`\n  Of the rows that would update:`);
    console.log(`    Tier:       STRONG ${tierCounts.STRONG ?? 0} · MODERATE ${tierCounts.MODERATE ?? 0} · WEAK ${tierCounts.WEAK ?? 0} · LOW ${tierCounts.LOW ?? 0}`);
    console.log(`    Confidence: HIGH ${confCounts.HIGH ?? 0} · MEDIUM ${confCounts.MEDIUM ?? 0} · LOW ${confCounts.LOW ?? 0}`);

    // ── Safety footer ──
    console.log(`\n${LINE}`);
    console.log('  Safety confirmation');
    console.log(LINE);
    if (dryRun) {
      console.log('  DB writes performed: 0  (DRY RUN)');
      console.log('  No records were updated.');
    } else {
      console.log(`  DB writes performed: ${written}`);
      console.log('  Only the 6 Ad benchmark fields + 2 AdAnalysis detail fields were updated.');
    }
    console.log('  Never modified: score, qualified, finalVerdict, copyScore, headlineScore,');
    console.log('                  creativeScore, AIDA scores, primaryCopy, headline, description, adSource.');
    console.log(LINE + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
