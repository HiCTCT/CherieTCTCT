import type { PrismaClient } from '@prisma/client';
import { analyseAdRow } from '@/lib/analysis';
import type { AdFormat } from '@/lib/analysis/types';
import type { ExampleRow } from '@/lib/data/manualExamples';

export async function ingestExampleRows(params: {
  prisma: PrismaClient;
  rows: ExampleRow[];
  format: AdFormat;
  clientId: string;
  industryId: string;
  competitorId: string;
  scanRunId?: string;
}) {
  const { prisma, rows, format, clientId, industryId, competitorId, scanRunId } = params;

  let processed = 0;
  let inserted = 0;
  let rejectedBelow7 = 0;

  for (const row of rows) {
    processed += 1;
    const analysed = analyseAdRow(row, format);

    if (!analysed.qualified) {
      rejectedBelow7 += 1;
      continue;
    }

    const now = new Date();

    const ad = await prisma.ad.create({
      data: {
        clientId,
        industryId,
        competitorId,
        productOrService: row.Product,
        adFormat: format,
        adLink:
          row['Ad Link'] ??
          `https://www.facebook.com/ads/library/?id=seed-${format.toLowerCase()}-${processed}`,
        activeSince: row['Active Since'] ? new Date(row['Active Since']) : undefined,
        primaryCopy: row.Copy,
        headline: row.Headline,
        description: row.Description,
        score: analysed.overallScore,
        qualified: analysed.qualified,
        firstSeenAt: now,
        lastSeenAt: now,
        adStatus: 'ACTIVE',
      },
    });

    await prisma.adAnalysis.create({
      data: {
        adId: ad.id,
        creativeAnalysis: analysed.creativeAnalysis,
        copyAnalysis: analysed.copyAnalysis,
        headlineAnalysis: analysed.headlineAnalysis,
        descriptionAnalysis: analysed.descriptionAnalysis,
        overallScore: analysed.overallScore,

        // Shared sub-scores
        hookStopScrollScore: analysed.subScores.hookStopScroll,
        audienceRelevanceScore: analysed.subScores.audienceRelevance,
        valueClarityScore: analysed.subScores.valueClarity,
        trustProofStrengthScore: analysed.subScores.trustProofStrength,
        ctaClarityScore: analysed.subScores.ctaClarity,

        // Static-specific sub-scores (undefined → null for video)
        visualHierarchyScore: analysed.subScores.visualHierarchy,
        productClarityScore: analysed.subScores.productClarity,
        offerClarityScore: analysed.subScores.offerClarity,
        headlineStrengthScore: analysed.subScores.headlineStrength,
        descriptionUsefulnessScore: analysed.subScores.descriptionUsefulness,
        ctaVisibilityScore: analysed.subScores.ctaVisibility,
        trustSignalsScore: analysed.subScores.trustSignals,

        // Video-specific sub-scores (undefined → null for static)
        firstThreeSecondsScore: analysed.subScores.firstThreeSeconds,
        soundOffDesignScore: analysed.subScores.soundOffDesign,
        soundOnEnhancementScore: analysed.subScores.soundOnEnhancement,
        onScreenTextScore: analysed.subScores.onScreenText,
        storyFlowScore: analysed.subScores.storyFlow,
        authenticityScore: analysed.subScores.authenticity,
        platformNativeFeelScore: analysed.subScores.platformNativeFeel,

        // Framework mapping
        aidaJson: JSON.stringify(analysed.aida),
        funnelStage: analysed.funnelStage,
        raceStage: analysed.raceStage,

        strengthsJson: JSON.stringify(analysed.strengths),
        weaknessesJson: JSON.stringify(analysed.weaknesses),
        improvementsJson: JSON.stringify(analysed.improvements),
        rubricScoresJson: JSON.stringify(analysed.subScores),
      },
    });

    if (scanRunId) {
      await prisma.adScanRecord.create({
        data: {
          adId: ad.id,
          scanRunId,
          action: 'DISCOVERED',
        },
      });
    }

    inserted += 1;
  }

  return { processed, inserted, rejectedBelow7 };
}
