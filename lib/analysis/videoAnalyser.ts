import {
  deriveOverallScore,
  mapFunnelStage,
  mapRaceStage,
  qualifies,
  scoreBySignals,
} from '@/lib/analysis/scoring';
import type { AnalysisOutput, ExampleRow } from '@/lib/analysis/types';

export function analyseVideoAd(row: ExampleRow): AnalysisOutput {
  const copy = row.Copy ?? '';
  const headline = row.Headline ?? '';
  const description = row.Description ?? '';
  const analysisReference = `${row.Analysis ?? ''} ${row['Creative Analysis'] ?? ''}`;
  const allText = `${copy} ${headline} ${description} ${analysisReference}`;

  const subScores = {
    hookStopScroll: scoreBySignals(allText, [
      /hook|0-3|first\s*(three|3)|stop-scroll/i,
      /bold|strong opening|pattern interrupt/i,
    ]),
    audienceRelevance: scoreBySignals(allText, [
      /audience|target|persona|for\s+\w+/i,
      /pain point|problem/i,
    ]),
    valueClarity: scoreBySignals(allText, [
      /benefit|value|outcome|result|transform/i,
      /clear|simple/i,
    ]),
    trustProofStrength: scoreBySignals(allText, [
      /testimonial|proof|real|case study|results/i,
      /credibility|guarantee|review/i,
    ]),
    ctaClarity: scoreBySignals(allText, [
      /book|start|get started|learn more|shop|register/i,
      /now|today/i,
    ]),
    firstThreeSeconds: scoreBySignals(analysisReference, [
      /0-3|first\s*(three|3)|opening/i,
    ]),
    soundOffDesign: scoreBySignals(analysisReference, [
      /caption|subtitle|sound-off|text overlay/i,
    ]),
    soundOnEnhancement: scoreBySignals(analysisReference, [
      /voice|audio|music|sound-on/i,
    ]),
    onScreenText: scoreBySignals(analysisReference, [
      /on-screen|overlay|text|caption/i,
    ]),
    storyFlow: scoreBySignals(analysisReference, [
      /story|flow|sequence|narrative/i,
    ]),
    authenticity: scoreBySignals(analysisReference, [
      /authentic|real people|founder|customer/i,
    ]),
    platformNativeFeel: scoreBySignals(analysisReference, [
      /reels|stories|ugc|platform-native|vertical/i,
    ]),
  };

  const overallScore = deriveOverallScore(Object.values(subScores));

  return {
    overallScore,
    qualified: qualifies(overallScore),
    subScores,
    creativeAnalysis:
      row['Creative Analysis'] ??
      'Video creative was assessed for first 0–3 seconds, flow, and platform-native fit.',
    copyAnalysis:
      row.Analysis ??
      'Video copy was assessed for relevance, value clarity, and CTA direction.',
    headlineAnalysis: headline
      ? `Headline supports video narrative: "${headline}".`
      : 'Headline missing; this can reduce context when users skim quickly.',
    descriptionAnalysis: description
      ? 'Description complements video messaging and can support stronger conversion intent.'
      : 'Description missing; add short supporting detail for feed context.',
    aida: {
      attention:
        'Opening 0–3 seconds and stop-scroll strength are scored as primary Attention drivers.',
      interest:
        'Story flow and audience relevance are scored to maintain Interest.',
      desire:
        'Value clarity and trust/proof cues are scored for Desire.',
      action:
        'CTA clarity plus sound-off/on execution are scored for Action readiness.',
    },
    funnelStage: mapFunnelStage(copy),
    raceStage: mapRaceStage(copy),
    strengths: [
      'Video-specific checks capture sound-off design and opening hook quality.',
      'On-screen text and platform-native feel are explicitly scored.',
    ],
    weaknesses: [
      ...(analysisReference.match(/caption|subtitle|sound-off/i)
        ? []
        : ['Limited explicit sound-off support detected.']),
      ...(analysisReference.match(/story|flow|sequence/i)
        ? []
        : ['Story flow is not explicit in the reference notes.']),
    ],
    improvements: [
      row.Improvement ??
        'Strengthen the first three seconds with a clear pain-point hook.',
      row['Creative Improvements'] ??
        'Add readable on-screen text for sound-off viewing.',
      'Use a clearer single CTA in the final third of the video.',
    ],
  };
}
