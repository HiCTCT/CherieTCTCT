/**
 * Phase 4 Step 5 — Meta Ad Ingestion targeted by competitor Meta Page ID
 *
 * Fetches ads from the Meta Ad Library API and writes them to the database as
 * discovered competitor activity. All writes are guarded by the dryRun flag.
 *
 * Design invariants enforced here:
 *  - competitor.metaPageId is required before any fetch occurs
 *  - fetchConfig.searchPageIds is forced to [competitor.metaPageId]
 *  - qualified is always false for API-sourced ads (7.0 threshold is not weakened)
 *  - reviewStatus is always 'PENDING' on first insert
 *  - adSource is always 'meta_api'
 *  - adLink is always run through redactToken() before storage
 *  - metaAdId uniqueness is checked before every insert (deduplication)
 *  - Post-write token safety verification queries for any stored access_token= value
 */

import type { PrismaClient } from '@prisma/client';
import { analyseAdRow } from '@/lib/analysis';
import type { AdFormat, AnalysisOutput, ExampleRow } from '@/lib/analysis/types';
import { fetchMetaAds } from '@/lib/providers/meta/fetch';
import type { MetaAdRecord, MetaFetchConfig } from '@/lib/providers/meta/types';
import { redactToken } from '@/lib/providers/meta/redact';

export type IngestionConfig = {
  competitorId: string;
  fetchConfig: MetaFetchConfig;
  dryRun: boolean;
};

export type IngestionResult = {
  adsProcessed: number;
  adsInserted: number;
  adsSkipped: number;
  adsErrored: number;
  scanRunId: string | null;
};

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

export async function ingestMetaAds(
  config: IngestionConfig,
  prisma: PrismaClient,
): Promise<IngestionResult> {
  const { competitorId, fetchConfig, dryRun } = config;

  const competitor = await prisma.competitor.findUniqueOrThrow({
    where: { id: competitorId },
    select: {
      id: true,
      name: true,
      clientId: true,
      industryId: true,
      metaPageId: true,
    },
  });

  if (!competitor.metaPageId) {
    throw new Error(
      `Competitor "${competitor.name}" has no Meta Page ID configured. ` +
        'Set it via the competitor config page before running ingestion.',
    );
  }

  fetchConfig.searchPageIds = [competitor.metaPageId];

  console.log(`\n  Competitor:   ${competitor.name} (${competitor.id})`);
  console.log(`  Client ID:    ${competitor.clientId}`);
  console.log(`  Industry ID:  ${competitor.industryId}`);
  console.log(`  Meta Page ID: ${competitor.metaPageId}`);

  const records = await fetchMetaAds(fetchConfig);

  if (records.length === 0) {
    console.log('  No records returned. Nothing to ingest.');
    return { adsProcessed: 0, adsInserted: 0, adsSkipped: 0, adsErrored: 0, scanRunId: null };
  }

  type Processed = {
    record: MetaAdRecord;
    row: ExampleRow;
    analysis: AnalysisOutput;
    safeAdLink: string;
    adStatus: string;
  };

  const processed: Processed[] = records.map((record) => {
    const row = normaliseRecord(record);
    return {
      record,
      row,
      analysis: analyseAdRow(row, fetchConfig.format as AdFormat),
      safeAdLink: record.ad_snapshot_url ? redactToken(record.ad_snapshot_url) : '',
      adStatus: deriveAdStatus(record),
    };
  });

  if (dryRun) {
    console.log('\n  DRY RUN - no DB writes');
    console.log(`  Would create 1 ScanRun (source: META_API, status: IN_PROGRESS to COMPLETED)`);
    console.log(`  Would process ${processed.length} ad record(s):\n`);

    for (let i = 0; i < processed.length; i++) {
      const { record, analysis, safeAdLink, adStatus } = processed[i];
      const metaAdId = record.id ?? `(no id - index ${i})`;
      const hasId = !!record.id;

      console.log(`  [${i + 1}/${processed.length}]`);
      console.log(`    metaAdId:     ${metaAdId}${hasId ? '' : ' - WOULD BE SKIPPED (no id)'}`);
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

    return {
      adsProcessed: processed.length,
      adsInserted: 0,
      adsSkipped: 0,
      adsErrored: 0,
      scanRunId: null,
    };
  }

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

  for (const { record, analysis, safeAdLink, adStatus } of processed) {
    const metaAdId = record.id;

    if (!metaAdId) {
      console.log(`  Skipping record with no id (page: ${record.page_name ?? 'unknown'})`);
      errored++;
      continue;
    }

    const existing = await prisma.ad.findUnique({ where: { metaAdId } });
    if (existing) {
      await prisma.ad.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: new Date(),
          adStatus,
        },
      });
      await prisma.adScanRecord.create({
        data: { adId: existing.id, scanRunId: scanRun.id, action: 'SEEN' },
      });
      console.log(`  Updated lifecycle (SEEN): ${metaAdId} | adStatus: ${adStatus}`);
      skipped++;
      continue;
    }

    const ad = await prisma.ad.create({
      data: {
        metaAdId,
        adSource: 'meta_api',
        reviewStatus: 'PENDING',
        competitorId,
        clientId: competitor.clientId,
        industryId: competitor.industryId,
        adFormat: fetchConfig.format,
        adLink: safeAdLink,
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

    await prisma.adAnalysis.create({
      data: {
        adId: ad.id,
        creativeAnalysis: '',
        copyAnalysis: '',
        headlineAnalysis: '',
        descriptionAnalysis: '',
        strengthsJson: JSON.stringify(analysis.strengths),
        weaknessesJson: JSON.stringify(analysis.weaknesses),
        improvementsJson: JSON.stringify(analysis.improvements),
        rubricScoresJson: JSON.stringify(analysis.subScores),
        overallScore: analysis.overallScore,
        aidaJson: JSON.stringify(analysis.aida),
        funnelStage: analysis.funnelStage,
        raceStage: analysis.raceStage,
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
        hookStopScrollScore: analysis.subScores.hookStopScroll,
        audienceRelevanceScore: analysis.subScores.audienceRelevance,
        valueClarityScore: analysis.subScores.valueClarity,
        trustProofStrengthScore: analysis.subScores.trustProofStrength,
        ctaClarityScore: analysis.subScores.ctaClarity,
        visualHierarchyScore: analysis.subScores.visualHierarchy ?? null,
        productClarityScore: analysis.subScores.productClarity ?? null,
        offerClarityScore: analysis.subScores.offerClarity ?? null,
        headlineStrengthScore: analysis.subScores.headlineStrength ?? null,
        descriptionUsefulnessScore: analysis.subScores.descriptionUsefulness ?? null,
        ctaVisibilityScore: analysis.subScores.ctaVisibility ?? null,
        trustSignalsScore: analysis.subScores.trustSignals ?? null,
        firstThreeSecondsScore: analysis.subScores.firstThreeSeconds ?? null,
        soundOffDesignScore: analysis.subScores.soundOffDesign ?? null,
        soundOnEnhancementScore: analysis.subScores.soundOnEnhancement ?? null,
        onScreenTextScore: analysis.subScores.onScreenText ?? null,
        storyFlowScore: analysis.subScores.storyFlow ?? null,
        authenticityScore: analysis.subScores.authenticity ?? null,
        platformNativeFeelScore: analysis.subScores.platformNativeFeel ?? null,
      },
    });

    await prisma.adScanRecord.create({
      data: { adId: ad.id, scanRunId: scanRun.id, action: 'NEW' },
    });

    console.log(
      `  Inserted: ${metaAdId} | score: ${analysis.overallScore.toFixed(1)} | verdict: ${analysis.finalVerdict}`,
    );
    inserted++;
  }

  await prisma.scanRun.update({
    where: { id: scanRun.id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      newAdsFound: inserted,
      adsUnchanged: skipped,
    },
  });

  await prisma.competitor.update({
    where: { id: competitorId },
    data: { lastScannedAt: new Date() },
  });

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

  console.log('  Token safety verified - no access_token= in stored adLink values');

  return {
    adsProcessed: processed.length,
    adsInserted: inserted,
    adsSkipped: skipped,
    adsErrored: errored,
    scanRunId: scanRun.id,
  };
}
