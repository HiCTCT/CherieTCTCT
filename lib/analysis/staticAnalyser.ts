import { deriveOverallScore, mapFunnelStage, mapRaceStage, qualifies, scoreBySignals } from '@/lib/analysis/scoring';
import type { AnalyseInput, AnalysisOutput } from '@/lib/analysis/types';

export function analyseStaticAd(input: AnalyseInput): AnalysisOutput {
  const row = input.row;
  const copy = row.Copy ?? '';
  const headline = row.Headline ?? '';
  const description = row.Description ?? '';
  const analysisReference = `${row.Analysis ?? ''} ${row['Creative Analysis'] ?? ''}`;
  const allText = `${copy} ${headline} ${description} ${analysisReference}`;

  const subScores = {
    hookStopScroll: scoreBySignals(allText, [/bold|strong|attention|scroll|first/i, /benefit|result|outcome/i]),
    audienceRelevance: scoreBySignals(allText, [/audience|for\s+\w+/i, /business|marketer|owner|customer/i]),
    valueClarity: scoreBySignals(allText, [/benefit|value|save|growth|revenue|improve/i, /clear|simple|easy/i]),
    trustProofStrength: scoreBySignals(allText, [/testimonial|proof|trusted|case study|results/i, /award|certified|guarantee/i]),
    ctaClarity: scoreBySignals(allText, [/book|start|get started|learn more|shop|register/i, /today|now/i]),
    visualHierarchy: scoreBySignals(analysisReference, [/visual|hierarchy|contrast|layout|design/i]),
    productClarity: scoreBySignals(allText, [/product|service|what|solution/i]),
    offerClarity: scoreBySignals(allText, [/offer|free|discount|trial|subsidy/i]),
    headlineStrength: scoreBySignals(headline, [/benefit|result|more|faster|easy|clear/i]),
    descriptionUsefulness: scoreBySignals(description, [/detail|support|context|what you get/i]),
    ctaVisibility: scoreBySignals(allText, [/cta|call to action|book|register|start/i]),
    trustSignals: scoreBySignals(allText, [/proof|testimonial|trust|review|rating/i]),
  };

  const overallScore = deriveOverallScore(Object.values(subScores));

  return {
    overallScore,
    qualified: qualifies(overallScore),
    subScores,
    creativeAnalysis: row['Creative Analysis'] ?? 'Static creative was assessed for hierarchy, offer clarity, and trust signals.',
    copyAnalysis: row.Analysis ?? 'Copy was assessed for relevance, value clarity, and funnel fit.',
    headlineAnalysis: headline
      ? `Headline emphasises: "${headline}". Strength is judged on clarity and outcome focus.`
      : 'Headline missing; this reduces stop-scroll and value transfer.',
    descriptionAnalysis: description
      ? 'Description adds supporting context and should reinforce trust and CTA clarity.'
      : 'Description missing; ad may lose context for lower-intent audiences.',
    aida: {
      attention: 'Headline and visual treatment are scored for stop-scroll effect.',
      interest: 'Copy relevance and product clarity are scored for audience fit.',
      desire: 'Value proposition and trust signals are scored for motivation strength.',
      action: 'CTA clarity and CTA visibility are scored for conversion intent.',
    },
    funnelStage: mapFunnelStage(copy),
    raceStage: mapRaceStage(copy),
    strengths: [
      'Static-specific checks include visual hierarchy and trust signals.',
      'Framework mapping is persisted for AIDA, funnel, and RACE.',
    ],
    weaknesses: [
      ...(description ? [] : ['Description is missing or thin.']),
      ...(headline ? [] : ['Headline is missing or too weak for stop-scroll.']),
    ],
    improvements: [
      row.Improvement ?? 'Make the CTA explicit and tie it to one clear outcome.',
      row['Creative Improvements'] ?? 'Increase contrast and product-first visual hierarchy.',
      'Add a concrete trust marker (numbers, testimonial, or certification).',
    ],
  };
}
