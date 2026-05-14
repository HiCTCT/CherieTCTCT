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

export function analyseStaticAd(row: ExampleRow): AnalysisOutput {
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
  const creativeScore = scoreCreativeStrength(creativeAnalysisText, 'STATIC', analysisNotes);

  // Pass analysisNotes so explicit human AIDA scores (e.g. "Attention 9/10") are used when present
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
  const subScores = {
    hookStopScroll: scoreBySignals(allText, [/bold|strong|attention|scroll|first/i, /benefit|result|outcome/i]),
    audienceRelevance: scoreBySignals(allText, [/audience|for\s+\w+/i, /business|marketer|owner|customer|company/i]),
    valueClarity: scoreBySignals(allText, [/benefit|value|save|growth|revenue|improve|scale/i, /clear|simple|easy/i]),
    trustProofStrength: scoreBySignals(allText, [/testimonial|proof|trusted|case study|results|Fortune/i, /award|certified|guarantee|authority/i]),
    ctaClarity: scoreBySignals(allText, [/book|start|get started|learn more|shop|register/i, /today|now/i]),
    visualHierarchy: scoreBySignals(creativeAnalysisText || analysisNotes, [/visual|hierarchy|contrast|layout|design|minimalist/i]),
    productClarity: scoreBySignals(allText, [/product|service|what|solution/i]),
    offerClarity: scoreBySignals(allText, [/offer|free|discount|trial|subsidy/i]),
    headlineStrength: scoreBySignals(headline, [/benefit|result|more|faster|easy|clear/i]),
    descriptionUsefulness: scoreBySignals(description, [/detail|support|context|what you get/i]),
    ctaVisibility: scoreBySignals(allText, [/cta|call to action|book|register|start/i]),
    trustSignals: scoreBySignals(allText, [/proof|testimonial|trust|review|rating|Fortune/i]),
  };

  // --- Narrative analysis fields ---
  // If analyst notes are present, pass them through unchanged — seed ads are unaffected.
  // If absent, build a structured multi-line fallback from already-computed signal data.
  // This is presentation only — no numeric scores change.

  const copyAnalysisText = analysisNotes && analysisNotes.trim().length > 5
    ? analysisNotes
    : [
        'AIDA Scores (machine-scored from copy and creative signals)',
        '',
        `Attention:  ${aidaScores.attention.toFixed(1)}/10 — ${
          aidaScores.attention >= 7
            ? 'Strong hook and visual stopping power.'
            : aidaScores.attention >= 5
              ? 'Hook and first impression need sharpening.'
              : 'Hook and first impression need significant work.'
        }`,
        `Interest:   ${aidaScores.interest.toFixed(1)}/10 — ${
          aidaScores.interest >= 7
            ? 'Audience relevance and problem fit are clear.'
            : aidaScores.interest >= 5
              ? 'Audience specificity and problem clarity need work.'
              : 'Audience connection and relevance signals are weak.'
        }`,
        `Desire:     ${aidaScores.desire.toFixed(1)}/10 — ${
          aidaScores.desire >= 7
            ? 'Benefit, proof, and offer are motivating.'
            : aidaScores.desire >= 5
              ? 'Benefit and proof signals need strengthening.'
              : 'Benefit clarity and proof are largely absent.'
        }`,
        `Action:     ${aidaScores.action.toFixed(1)}/10 — ${
          aidaScores.action >= 7
            ? 'CTA is clear and actionable.'
            : aidaScores.action >= 5
              ? 'CTA and urgency need improvement.'
              : 'CTA and urgency signals are weak or absent.'
        }`,
        '',
        `Copy Score:      ${copyScore.toFixed(1)}/10 — ${
          copyScore >= 7
            ? 'Strong conversion signals detected. Hook, benefit, and CTA are present.'
            : copyScore >= 5
              ? 'Moderate signals. Some conversion elements are present but not fully sharpened.'
              : 'Weak conversion signals. Hook, proof, and CTA need significant strengthening.'
        }`,
        `Creative Score:  ${creativeScore.toFixed(1)}/10 — ${
          creativeScore >= 7
            ? 'Strong creative conversion signals. Visual hierarchy and offer prominence are well-executed.'
            : creativeScore >= 5
              ? 'Some creative conversion signals present. Offer prominence and visual hierarchy can be improved.'
              : 'Creative signals are weak. Offer visibility and visual hierarchy need work.'
        }`,
        '',
        `Funnel Stage:        ${funnelStage}`,
        `Trust Funnel Stage:  ${trustFunnelStage.replace(/_/g, ' ')}`,
        '',
        'Note: No analyst notes were provided. This analysis is based on automated signal detection only.',
      ].join('\n');

  const creativeAnalysisOutput = creativeAnalysisText && creativeAnalysisText.trim().length > 5
    ? creativeAnalysisText
    : analysisNotes && analysisNotes.trim().length > 5
      ? analysisNotes
      : [
          'Creative Analysis (machine-scored — STATIC format)',
          '',
          `Creative Score:  ${creativeScore.toFixed(1)}/10 — ${
            creativeScore >= 7
              ? 'Strong visual conversion signals. Visual hierarchy, offer prominence, and CTA are well-executed.'
              : creativeScore >= 5
                ? 'Some conversion signals present. Offer prominence and visual hierarchy need sharpening.'
                : 'Weak creative signals. Offer visibility, visual hierarchy, and CTA need significant work.'
          }`,
          '',
          'Format: STATIC (image or carousel)',
          '',
          'AIDA Contribution:',
          `  Attention:  ${aidaScores.attention.toFixed(1)}/10 — ${
            aidaScores.attention >= 7
              ? 'Visual stops the scroll. Strong first-frame impact.'
              : 'Visual stopping power and pattern interrupt need strengthening.'
          }`,
          `  Desire:     ${aidaScores.desire.toFixed(1)}/10 — ${
            aidaScores.desire >= 7
              ? 'Offer and benefit are visually prominent.'
              : 'Benefit and offer need to be more prominent visually.'
          }`,
          '',
          ...(
            behaviouralTriggers.filter((t) => t.strength !== 'MISSING').length > 0
              ? [
                  'Behavioural Triggers Detected:',
                  ...behaviouralTriggers
                    .filter((t) => t.strength !== 'MISSING')
                    .map((t) => `  ${t.name}: ${t.strength.charAt(0) + t.strength.slice(1).toLowerCase()}`),
                  '',
                ]
              : ['Behavioural Triggers: None detected from available signals.', '']
          ),
          'Note: No creative description was provided. This analysis is based on automated signal detection only.',
        ].join('\n');

  const headlineAnalysisText = headline
    ? `Headline scored ${(headlineScore ?? 0).toFixed(1)}/10. "${headline}" — ${
        (headlineScore ?? 0) >= 7
          ? 'Strong conversion intent with clear benefit or outcome framing.'
          : (headlineScore ?? 0) >= 5
            ? 'Present but lacks sharpness. Specificity and outcome focus should be strengthened.'
            : 'Weak on conversion intent. Needs clearer outcome, pain-point hook, or specificity.'
      }`
    : 'Headline not provided. No score assigned. Adding a headline is strongly recommended.';

  const descriptionAnalysisText = description
    ? `Description scored ${(descriptionScore ?? 0).toFixed(1)}/10. ${
        (descriptionScore ?? 0) >= 7
          ? 'Reinforces the ad with useful proof, urgency, or risk reduction.'
          : (descriptionScore ?? 0) >= 5
            ? 'Present but adds limited conversion value. Consider adding proof or a risk reducer.'
            : 'Weak. Should add something the headline and copy did not — proof, benefit, or risk reduction.'
      }`
    : 'Description not provided. No score assigned.';

  const strengths: string[] = [];
  const weaknesses: string[] = [];

  if (copyScore >= 7) strengths.push('Copy demonstrates strong conversion signals.');
  if (headlineScore !== null && headlineScore >= 7) strengths.push('Headline is clear, specific, and conversion-focused.');
  if (creativeScore >= 7) strengths.push('Creative shows strong visual conversion signals.');
  if (aidaScores.action >= 7) strengths.push('CTA and action intent are clearly communicated.');
  if (convictionScore >= 7) strengths.push('Strong proof and conviction signals present.');
  if (hasAuthorityAida && aidaAvg >= 8) strengths.push('Human analyst assessment confirms strong AIDA framework execution.');

  if (copyScore < 5) weaknesses.push('Copy lacks sufficient conversion signals — hook, proof, or CTA are weak.');
  if (headlineScore === null) weaknesses.push('No headline provided. Reduces stop-scroll and value transfer.');
  if (headlineScore !== null && headlineScore < 5) weaknesses.push('Headline is weak on conversion intent.');
  if (descriptionScore === null) weaknesses.push('No description provided. A short description can reduce hesitation.');
  if (creativeScore < 5) weaknesses.push('Creative analysis absent or lacking conversion signals.');
  if (convictionScore < 5) weaknesses.push('Low conviction — no clear proof, guarantee, or trust signals.');

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
      attention: `Score: ${aidaScores.attention.toFixed(1)}/10. ${aidaScores.attention >= 7 ? 'Strong hook and visual stopping power.' : 'Hook and first impression need strengthening.'}`,
      interest: `Score: ${aidaScores.interest.toFixed(1)}/10. ${aidaScores.interest >= 7 ? 'Audience relevance and problem fit are clear.' : 'Audience specificity and problem clarity need work.'}`,
      desire: `Score: ${aidaScores.desire.toFixed(1)}/10. ${aidaScores.desire >= 7 ? 'Benefit, proof, and offer are motivating.' : 'Benefit and proof signals need strengthening.'}`,
      action: `Score: ${aidaScores.action.toFixed(1)}/10. ${aidaScores.action >= 7 ? 'CTA is clear and actionable.' : 'CTA and urgency signals need improvement.'}`,
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
      attention: `Hook clarity, first-frame stopping power, and visual impact. Score: ${aidaScores.attention.toFixed(1)}/10.`,
      interest: `Audience relevance, problem-fit, and product clarity. Score: ${aidaScores.interest.toFixed(1)}/10.`,
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
