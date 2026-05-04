import {
  clampScore,
  deriveOverallScore,
  deriveFinalVerdict,
  deriveRecommendations,
  deriveRewriteDirection,
  detectBehaviouralTriggers,
  extractAnalysisAidaScores,
  mapFunnelStage,
  mapRaceStage,
  mapTrustFunnelStage,
  qualifies,
  scoreAida,
  scoreClarityConnectionConviction,
  scoreCopyStrength,
  scoreCreativeStrength,
  scoreDescriptionStrength,
  scoreHeadlineStrength,
  scoreBySignals,
} from '@/lib/analysis/scoring';
import type { AnalysisOutput, ExampleRow } from '@/lib/analysis/types';

export function analyseVideoAd(row: ExampleRow): AnalysisOutput {
  const copy = row.Copy ?? '';
  const headline = row.Headline ?? '';
  const description = row.Description ?? '';
  const analysisNotes = row.Analysis ?? '';
  const creativeAnalysisText = row['Creative Analysis'] ?? '';
  const improvementNotes = row.Improvement ?? '';
  const creativeImprovementNotes = row['Creative Improvements'] ?? '';
  const otherFeedbacks = row['Other Feedbacks'] ?? '';

  const allText = `${copy} ${headline} ${description} ${analysisNotes} ${creativeAnalysisText} ${otherFeedbacks}`;

  // --- Phase 3.5: Conversion-focused component scores ---
  const copyScore = scoreCopyStrength(copy, `${analysisNotes} ${otherFeedbacks}`);
  const headlineScore = scoreHeadlineStrength(headline || undefined);
  const descriptionScore = scoreDescriptionStrength(description || undefined);

  // Pass analysisNotes so Creative Analysis fallback uses the rich analysis field
  const creativeScore = scoreCreativeStrength(creativeAnalysisText, 'VIDEO', analysisNotes);

  // Pass analysisNotes so explicit human AIDA scores (e.g. "Attention 9.2/10") are used when present
  const aidaScores = scoreAida(copy, headline, creativeAnalysisText, analysisNotes);
  const aidaAvg = clampScore(
    (aidaScores.attention + aidaScores.interest + aidaScores.desire + aidaScores.action) / 4,
  );

  // Pass analysisNotes so rich analysis text informs CCC scoring
  const { clarity: clarityScore, connection: connectionScore, conviction: convictionScore } =
    scoreClarityConnectionConviction(copy, headline, description, analysisNotes);

  const trustFunnelStage = mapTrustFunnelStage(copy, headline);
  const funnelStage = mapFunnelStage(copy);
  const raceStage = mapRaceStage(copy);

  // Pass analysisNotes so human analyst language surfaces behavioural triggers
  const behaviouralTriggers = detectBehaviouralTriggers(copy, headline, creativeAnalysisText, analysisNotes);

  const recommendations = deriveRecommendations(
    copyScore,
    headlineScore,
    descriptionScore,
    creativeScore,
    improvementNotes,
    creativeImprovementNotes,
  );

  // --- Overall score ---
  // When the human analyst has written explicit numeric AIDA scores in their analysis,
  // those scores are authoritative evidence — weight them 55% vs 45% for pattern scores.
  // Rationale: a human reviewing the actual ad is more reliable than regex on sparse copy text.
  const hasAuthorityAida = extractAnalysisAidaScores(analysisNotes) !== null;

  let overallScore: number;
  if (hasAuthorityAida) {
    const otherInputs = [copyScore, creativeScore, clarityScore, connectionScore, convictionScore];
    if (headlineScore !== null) otherInputs.push(headlineScore);
    if (descriptionScore !== null) otherInputs.push(descriptionScore);
    const otherAvg = deriveOverallScore(otherInputs);
    overallScore = clampScore(aidaAvg * 0.55 + otherAvg * 0.45);
  } else {
    const scoringInputs = [copyScore, creativeScore, aidaAvg, clarityScore, connectionScore, convictionScore];
    if (headlineScore !== null) scoringInputs.push(headlineScore);
    if (descriptionScore !== null) scoringInputs.push(descriptionScore);
    overallScore = deriveOverallScore(scoringInputs);
  }

  const rewriteDirection = deriveRewriteDirection(
    copyScore,
    headlineScore,
    descriptionScore,
    creativeScore,
    copy,
    funnelStage,
  );

  const finalVerdict = deriveFinalVerdict(
    copyScore,
    headlineScore,
    descriptionScore,
    creativeScore,
    overallScore,
  );

  // --- Backwards-compatible SubScores (kept for existing Prisma fields) ---
  // Video-specific signals included
  const subScores = {
    hookStopScroll: scoreBySignals(allText, [/hook|0-3|first\s*(three|3)|stop-scroll/i, /bold|strong opening|pattern interrupt/i]),
    audienceRelevance: scoreBySignals(allText, [/audience|target|persona|for\s+\w+/i, /pain point|problem/i]),
    valueClarity: scoreBySignals(allText, [/benefit|value|outcome|result|transform/i, /clear|simple/i]),
    trustProofStrength: scoreBySignals(allText, [/testimonial|proof|real|case study|results/i, /credibility|guarantee|review/i]),
    ctaClarity: scoreBySignals(allText, [/book|start|get started|learn more|shop|register/i, /now|today/i]),
    firstThreeSeconds: scoreBySignals(creativeAnalysisText || analysisNotes, [/0-3|first\s*(three|3)|opening|hook/i]),
    soundOffDesign: scoreBySignals(creativeAnalysisText || analysisNotes, [/caption|subtitle|sound.off|text overlay|on.screen/i]),
    soundOnEnhancement: scoreBySignals(creativeAnalysisText || analysisNotes, [/voice|audio|music|sound.on/i]),
    onScreenText: scoreBySignals(creativeAnalysisText || analysisNotes, [/on.screen|overlay|text|caption/i]),
    storyFlow: scoreBySignals(creativeAnalysisText || analysisNotes, [/story|flow|sequence|narrative|montage/i]),
    authenticity: scoreBySignals(creativeAnalysisText || analysisNotes, [/authentic|real people|founder|customer|testimonial/i]),
    platformNativeFeel: scoreBySignals(creativeAnalysisText || analysisNotes, [/reels|stories|ugc|platform.native|vertical/i]),
  };

  // --- Narrative analysis fields ---
  const copyAnalysisText = analysisNotes && analysisNotes.trim().length > 5
    ? analysisNotes
    : `Copy scored ${copyScore.toFixed(1)}/10. ${
        copyScore >= 7
          ? 'Strong conversion signals detected. Hook, benefit, and CTA are present.'
          : copyScore >= 5
            ? 'Moderate signals. Some conversion elements are present but not fully sharpened.'
            : 'Weak conversion signals. Hook, proof, and CTA need significant strengthening.'
      }`;

  const creativeAnalysisOutput = creativeAnalysisText && creativeAnalysisText.trim().length > 5
    ? creativeAnalysisText
    : analysisNotes && analysisNotes.trim().length > 5
      ? analysisNotes
      : `Creative scored ${creativeScore.toFixed(1)}/10. ${
          creativeScore >= 7
            ? 'Video creative shows strong conversion signals. Opening hook, sound-off design, and CTA are well-executed.'
            : 'Video creative analysis not provided. Score reflects available signals only. Assess first 3 seconds, sound-off readability, and CTA visibility.'
        }`;

  const headlineAnalysisText = headline
    ? `Headline scored ${(headlineScore ?? 0).toFixed(1)}/10. "${headline}" — ${
        (headlineScore ?? 0) >= 7
          ? 'Strong conversion intent. Supports the video narrative and conversion goal.'
          : (headlineScore ?? 0) >= 5
            ? 'Present but not sharp enough to drive clicks independently of the video.'
            : 'Weak on conversion intent. Needs clearer outcome, pain-point hook, or specificity.'
      }`
    : 'Headline not provided. No score assigned. A headline can drive clicks when the video is skipped.';

  const descriptionAnalysisText = description
    ? `Description scored ${(descriptionScore ?? 0).toFixed(1)}/10. ${
        (descriptionScore ?? 0) >= 7
          ? 'Reinforces the video message with proof, urgency, or risk reduction.'
          : (descriptionScore ?? 0) >= 5
            ? 'Present but adds limited conversion value. Consider proof or a risk reducer.'
            : 'Weak. Should add something the video and copy did not — proof, benefit, or risk reduction.'
      }`
    : 'Description not provided. No score assigned.';

  const strengths: string[] = [];
  const weaknesses: string[] = [];

  if (copyScore >= 7) strengths.push('Copy demonstrates strong conversion signals.');
  if (headlineScore !== null && headlineScore >= 7) strengths.push('Headline is clear, specific, and conversion-focused.');
  if (creativeScore >= 7) strengths.push('Video creative shows strong conversion execution.');
  if (aidaScores.attention >= 7) strengths.push('Opening hook and attention mechanics are strong.');
  if (convictionScore >= 7) strengths.push('Strong proof and conviction signals present.');
  if (hasAuthorityAida && aidaAvg >= 8) strengths.push('Human analyst assessment confirms strong AIDA framework execution.');
  if (/caption|subtitle|sound.off|text overlay/i.test(creativeAnalysisText || analysisNotes)) {
    strengths.push('Sound-off design is addressed — critical for feed environments.');
  }

  if (copyScore < 5) weaknesses.push('Copy lacks sufficient conversion signals — hook, proof, or CTA are weak.');
  if (headlineScore === null) weaknesses.push('No headline provided. Reduces click potential when video is skipped.');
  if (headlineScore !== null && headlineScore < 5) weaknesses.push('Headline is weak on conversion intent.');
  if (descriptionScore === null) weaknesses.push('No description provided. Can reduce hesitation in lower-intent viewers.');
  if (creativeScore < 5) weaknesses.push('Video creative analysis absent or lacking conversion signals.');
  if (convictionScore < 5) weaknesses.push('Low conviction — no clear proof, guarantee, or trust signals.');
  if (!/caption|subtitle|sound.off|text overlay/i.test(creativeAnalysisText || analysisNotes)) {
    weaknesses.push('No evidence of sound-off design. Most video ads are watched on mute — captions or text overlays are essential.');
  }

  // An ad qualifies only when score AND verdict are consistent.
  // TOO_VAGUE_MAJOR_REWORK or INSUFFICIENT_INFORMATION = do not insert, even if score reaches 7.0.
  const qualified = qualifies(overallScore)
    && finalVerdict !== 'TOO_VAGUE_MAJOR_REWORK'
    && finalVerdict !== 'INSUFFICIENT_INFORMATION';

  return {
    // Backwards-compatible fields
    overallScore,
    qualified,
    subScores,
    creativeAnalysis: creativeAnalysisOutput,
    copyAnalysis: copyAnalysisText,
    headlineAnalysis: headlineAnalysisText,
    descriptionAnalysis: descriptionAnalysisText,
    aida: {
      attention: `Score: ${aidaScores.attention.toFixed(1)}/10. ${aidaScores.attention >= 7 ? 'Strong opening hook and visual stopping power.' : 'Opening hook and first-frame impact need strengthening.'}`,
      interest: `Score: ${aidaScores.interest.toFixed(1)}/10. ${aidaScores.interest >= 7 ? 'Story flow and audience relevance maintain interest.' : 'Story flow and audience specificity need improvement.'}`,
      desire: `Score: ${aidaScores.desire.toFixed(1)}/10. ${aidaScores.desire >= 7 ? 'Benefit clarity and proof cues drive desire.' : 'Benefit and proof signals need strengthening.'}`,
      action: `Score: ${aidaScores.action.toFixed(1)}/10. ${aidaScores.action >= 7 ? 'CTA is clear and action-oriented.' : 'CTA and urgency needs improvement for conversion readiness.'}`,
    },
    funnelStage,
    raceStage,
    strengths: strengths.length > 0 ? strengths : ['Insufficient signals to identify clear strengths.'],
    weaknesses: weaknesses.length > 0 ? weaknesses : ['No major weaknesses detected from available signals.'],
    improvements: [recommendations.copy, recommendations.headline, recommendations.creative],

    // Phase 3.5 fields
    copyScore,
    headlineScore,
    descriptionScore,
    creativeScore,
    aidaScores,
    aidaExplanations: {
      attention: `Opening hook, first-frame impact, and pattern interrupt strength. Score: ${aidaScores.attention.toFixed(1)}/10.`,
      interest: `Story flow, audience relevance, and problem fit. Score: ${aidaScores.interest.toFixed(1)}/10.`,
      desire: `Benefit specificity, proof strength, and offer clarity. Score: ${aidaScores.desire.toFixed(1)}/10.`,
      action: `CTA directness, urgency signals, and friction reduction. Score: ${aidaScores.action.toFixed(1)}/10.`,
    },
    clarityScore,
    connectionScore,
    convictionScore,
    trustFunnelStage,
    behaviouralTriggers,
    recommendations,
    rewriteDirection,
    finalVerdict,
  };
}
