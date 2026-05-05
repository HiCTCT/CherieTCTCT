/**
 * Phase 4 Step 2 — Meta Ad Ingestion
 *
 * Fetches ads from the Meta Ad Library API and writes them to the database as
 * discovered competitor activity. All writes are guarded by the dryRun flag.
 *
 * Design invariants enforced here:
 *  - qualified is always false for API-sourced ads (7.0 threshold is not weakened)
 *  - reviewStatus is always 'PENDING' on first insert
 *  - adSource is always 'meta_api'
 *  - adLink is always run through redactToken() before storage
 *  - metaAdId uniqueness is checked before every insert (deduplication)
 *  - Post-write token safety verification queries for any stored access_token= value
 *  - paging.next is consumed by fetchMetaAds() and never reaches this layer
 */

import type { PrismaClient } from '@prisma/client';
import { analyseAdRow } from '@/lib/analysis';
import type { AdFormat, AnalysisOutput, ExampleRow } from '@/lib/analysis/types';
import { fetchMetaAds } from '@/lib/providers/meta/fetch';
import type { MetaAdRecord, MetaFetchConfig } from '@/lib/providers/meta/types';
import { redactToken } from '@/lib/providers/meta/redact';

// ─── Types ────────────────────────────────────────────────────────────────────

export type IngestionConfig = {
  /** Prisma cuid of the Competitor whose library this scan targets */
  competitorId: string;
  /** Meta fetch parameters — built by buildConfigFromEnv() in the calling script */
  fetchConfig: MetaFetchConfig;
  /**
   * When true: fetch, normalise, analyse, and print what would be written,
   * then return without any Prisma writes. Competitor lookup (read) still runs.
   */
  dryRun: boolean;
};

export type IngestionResult = {
  adsProcessed: number;
  adsInserted: number;
  /** Duplicates — metaAdId already exists in the database */
  adsSkipped: number;
  /** Records with no id field — cannot deduplicate, skipped */
  adsErrored: number;
  /** null when dryRun is true */
  scanRunId: string | null;
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

function firstOrEmpty(values: string[] | undefined): string {
  if (!values || values.length === 0) return '';
  return values[0];
}

function normaliseRecord(record: MetaAdRecord): ExampleRow {
  return {
    Product: record.page_name ?? 'Unknown Advertiser',
    'Ad Link': record.ad_snapshot_url ?? '',
    Copy: firstOrEmpty(record.ad_creative_bodies),
    Headline: firstOrEmpty(record.ad_creative_link_titles),
    Description: firstOrEmpty(record.ad_creative_link_descriptions),
    'Active Since': record.ad_delivery_start_time ?? '',
    Analysis: undefined,
    Improvement: undefined,
    'Creative Analysis': undefined,
    'Creative Improvements': undefined,
    'Other Feedbacks': undefined,
  };
}

function parseActiveSince(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function deriveAdStatus(record: MetaAdRecord): string {
  return record.ad_delivery_stop_time ? 'INACTIVE' : 'ACTIVE';
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Core ingestion function. Fetches Meta ads, analyses them, and writes to the
 * database under the specified Competitor. Pass dryRun=true to prove the full
 * chain without any database writes.
 *
 * Token safety:
 *  - ad_snapshot_url is run through redactToken() before assignment to adLink
 *  - After all writes, a verification query asserts no stored adLink contains
 *    access_token= — throws with a TOKEN SAFETY VIOLATION message if found
 *  - Error messages from fetch are already redacted by fetchMetaAds()
 */
export async function ingestMetaAds(
  config: IngestionConfig,
  prisma: PrismaClient,
): Promise<IngestionResult> {
  const { competitorId, fetchConfig, dryRun } = config;

  // ── 1. Load Competitor ──────────────────────────────────────────────────────
  // Always runs — dry-run skips writes, not reads.
  const competitor = await prisma.competitor.findUniqueOrThrow({
    where: { id: competitorId },
    select: { id: true, name: true, clientId: true, industryId: true },
  });

  console.log(`\n  Competitor:   ${competitor.name} (${competitor.id})`);
  console.log(`  Client ID:    ${competitor.clientId}`);
  console.log(`  Industry ID:  ${competitor.industryId}`);

  // ── 2. Fetch ────────────────────────────────────────────────────────────────
  const records = await fetchMetaAds(fetchConfig);

  if (records.length === 0) {
    console.log('  No records returned. Nothing to ingest.');
    return { adsProcessed: 0, adsInserted: 0, adsSkipped: 0, adsErrored: 0, scanRunId: null };
  }

  // ── 3. Normalise + Analyse ──────────────────────────────────────────────────
  type Processed = {
    record: MetaAdRecord;
    row: ExampleRow;
    analysis: AnalysisOutput;
    safeAdLink: string;
    adStatus: string;
  };

  const processed: Processed[] = records.map((record) => ({
    record,
    row: normaliseRecord(record),
    analysis: analyseAdRow(normaliseRecord(record), fetchConfig.format as AdFormat),
    // Token stripped here — this is the value that will be stored in adLink
    safeAdLink: record.ad_snapshot_url ? redactToken(record.ad_snapshot_url) : '',
    adStatus: deriveAdStatus(record),
  }));

  // ── 4. Dry-run: print plan and exit ─────────────────────────────────────────
  if (dryRun) {
    console.log('\n  ── DRY RUN — no DB writes ──────────────────────────────────');
    console.log(`\n  Would create 1 ScanRun (source: META_API, status: IN_PROGRESS → COMPLETED)`);
    console.log(`  Would process ${processed.length} ad record(s):\n`);

    for (let i = 0; i < processed.length; i++) {
      const { record, analysis, safeAdLink, adStatus } = processed[i];
      const metaAdId = record.id ?? `(no id — index ${i})`;
      const hasId = !!record.id;

      console.log(`  [${i + 1}/${processed.length}]`);
      console.log(`    metaAdId:     ${metaAdId}${hasId ? '' : ' ← WOULD BE SKIPPED (no id)'}`);
      console.log(`    advertiser:   ${record.page_name ?? 'Unknown'}`);
      console.log(`    adSource:     meta_api`);
      console.log(`    reviewStatus: PENDING`);
      console.log(`    qualified:    false`);
      console.log(`    adStatus:     ${adStatus}`);
      console.log(`    score:        ${analysis.overallScore.toFixed(1)} / 10`);
      console.log(`    finalVerdict: ${analysis.finalVerdict}`);
      console.log(`    adLink:       ${safeAdLink || '(empty)'}`);
      console.log(`    platforms:    ${record.publisher_platforms?.join(', ') ?? 'N/A'}`);
    }

    console.log('\n  Written to DB: 0');
    console.log('  ────────────────────────────────────────────────────────────');

    return {
      adsProcessed: processed.length,
      adsInserted: 0,
      adsSkipped: 0,
      adsErrored: 0,
      scanRunId: null,
    };
  }

  // ── 5. Create ScanRun ───────────────────────────────────────────────────────
  const scanRun = await prisma.scanRun.create({
    data: {
      competitorId,
      source: 'META_API',
      status: 'IN_PROGRESS',
    },
  });

  console.log(`\n  ScanRun created: ${scanRun.id}`);

  let inserted = 0;
  let skipped = 0;
  let errored = 0;

  // ── 6. Ingest each record ───────────────────────────────────────────────────
  for (const { record, analysis, safeAdLink, adStatus } of processed) {
    const metaAdId = record.id;

    // Records with no id cannot be deduplicated — skip
    if (!metaAdId) {
      console.log(`  ⚠  Skipping record with no id (page: ${record.page_name ?? 'unknown'})`);
      errored++;
      continue;
    }

    // Deduplication: update lifecycle fields and record as SEEN — no reinsert
    const existing = await prisma.ad.findUnique({ where: { metaAdId } });
    if (existing) {
      // Update lastSeenAt and adStatus to reflect current fetch state
      await prisma.ad.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: new Date(),
          adStatus,
        },
      });
      // Record that this ad was seen in this scan
      await prisma.adScanRecord.create({
        data: { adId: existing.id, scanRunId: scanRun.id, action: 'SEEN' },
      });
      console.log(`  → Updated lifecycle (SEEN): ${metaAdId} | adStatus: ${adStatus}`);
      skipped++;
      continue;
    }

    // Create Ad
    // qualified is always false — API-sourced ads enter as discovered activity
    // reviewStatus='PENDING' — requires human review before promotion to library
    const ad = await prisma.ad.create({
      data: {
        metaAdId,
        adSource: 'meta_api',
        reviewStatus: 'PENDING',
        competitorId,
        clientId: competitor.clientId,
        industryId: competitor.industryId,
        adFormat: fetchConfig.format,
        adLink: safeAdLink,              // token already stripped by redactToken()
        productOrService: record.page_name ?? null,
        primaryCopy: firstOrEmpty(record.ad_creative_bodies) || null,
        headline: firstOrEmpty(record.ad_creative_link_titles) || null,
        description: firstOrEmpty(record.ad_creative_link_descriptions) || null,
        activeSince: parseActiveSince(record.ad_delivery_start_time),
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        adStatus,
        score: analysis.overallScore,
        qualified: false,
      },
    });

    // Create AdAnalysis — all component scores stored even when below 7.0
    await prisma.adAnalysis.create({
      data: {
        adId: ad.id,
        // Human-written fields are empty for API-sourced ads
        creativeAnalysis: '',
        copyAnalysis: '',
        headlineAnalysis: '',
        descriptionAnalysis: '',
        // Computed fields
        strengthsJson: JSON.stringify(analysis.strengths),
        weaknessesJson: JSON.stringify(analysis.weaknesses),
        improvementsJson: JSON.stringify(analysis.improvements),
        rubricScoresJson: JSON.stringify(analysis.subScores),
        overallScore: analysis.overallScore,
        aidaJson: JSON.stringify(analysis.aida),
        funnelStage: analysis.funnelStage,
        raceStage: analysis.raceStage,
        // Phase 3.5 conversion scoring
        copyScore: analysis.copyScore,
        headlineScore: analysis.headlineScore,
        descriptionScore: analysis.descriptionScore,
        creativeScore: analysis.creativeScore,
        aidaAttentionScore: analysis.aidaScores.attention,
        aidaInterestScore: analysis.aidaScores.interest,
        aidaDesireScore: analysis.aidaScores.desire,
        aidaActionScore: analysis.aidaScores.action,
        clarityScore: analysis.clarityScore,
        connectionScore: analysis.connectionScore,
        convictionScore: analysis.convictionScore,
        trustFunnelStage: analysis.trustFunnelStage,
        behaviouralTriggersJson: JSON.stringify(analysis.behaviouralTriggers),
        recommendationsJson: JSON.stringify(analysis.recommendations),
        rewriteDirectionJson: analysis.rewriteDirection
          ? JSON.stringify(analysis.rewriteDirection)
          : null,
        finalVerdict: analysis.finalVerdict,
        // Shared sub-scores
        hookStopScrollScore: analysis.subScores.hookStopScroll,
        audienceRelevanceScore: analysis.subScores.audienceRelevance,
        valueClarityScore: analysis.subScores.valueClarity,
        trustProofStrengthScore: analysis.subScores.trustProofStrength,
        ctaClarityScore: analysis.subScores.ctaClarity,
        // Static-specific sub-scores (null for video)
        visualHierarchyScore: analysis.subScores.visualHierarchy ?? null,
        productClarityScore: analysis.subScores.productClarity ?? null,
        offerClarityScore: analysis.subScores.offerClarity ?? null,
        headlineStrengthScore: analysis.subScores.headlineStrength ?? null,
        descriptionUsefulnessScore: analysis.subScores.descriptionUsefulness ?? null,
        ctaVisibilityScore: analysis.subScores.ctaVisibility ?? null,
        trustSignalsScore: analysis.subScores.trustSignals ?? null,
        // Video-specific sub-scores (null for static)
        firstThreeSecondsScore: analysis.subScores.firstThreeSeconds ?? null,
        soundOffDesignScore: analysis.subScores.soundOffDesign ?? null,
        soundOnEnhancementScore: analysis.subScores.soundOnEnhancement ?? null,
        onScreenTextScore: analysis.subScores.onScreenText ?? null,
        storyFlowScore: analysis.subScores.storyFlow ?? null,
        authenticityScore: analysis.subScores.authenticity ?? null,
        platformNativeFeelScore: analysis.subScores.platformNativeFeel ?? null,
      },
    });

    // Link Ad to this ScanRun
    await prisma.adScanRecord.create({
      data: { adId: ad.id, scanRunId: scanRun.id, action: 'NEW' },
    });

    console.log(
      `  ✓ Inserted: ${metaAdId} | score: ${analysis.overallScore.toFixed(1)} | verdict: ${analysis.finalVerdict}`,
    );
    inserted++;
  }

  // ── 7. Close ScanRun ────────────────────────────────────────────────────────
  await prisma.scanRun.update({
    where: { id: scanRun.id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      newAdsFound: inserted,
      adsUnchanged: skipped,
    },
  });

  // ── 8. Update Competitor.lastScannedAt ──────────────────────────────────────
  await prisma.competitor.update({
    where: { id: competitorId },
    data: { lastScannedAt: new Date() },
  });

  // ── 9. Token safety verification ────────────────────────────────────────────
  // Query all API-sourced Ads and assert none have a bare access_token= in adLink.
  // This is a hard post-write invariant — any match means redactToken() was bypassed.
  const leakedTokenAds = await prisma.ad.findMany({
    where: {
      adSource: 'meta_api',
      adLink: { contains: 'access_token=' },
    },
    select: { id: true, metaAdId: true },
  });

  if (leakedTokenAds.length > 0) {
    const ids = leakedTokenAds.map((a) => a.metaAdId ?? a.id).join(', ');
    throw new Error(
      `TOKEN SAFETY VIOLATION: ${leakedTokenAds.length} Ad record(s) contain access_token= in adLink. ` +
        `Affected metaAdId(s): ${ids}. Investigate immediately.`,
    );
  }

  console.log('  ✓ Token safety verified — no access_token= in stored adLink values');

  return {
    adsProcessed: processed.length,
    adsInserted: inserted,
    adsSkipped: skipped,
    adsErrored: errored,
    scanRunId: scanRun.id,
  };
}
