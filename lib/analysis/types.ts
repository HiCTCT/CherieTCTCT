import type { ExampleRow } from '@/lib/data/manualExamples';

export type AdFormat = 'STATIC' | 'VIDEO';

export type FunnelStage = 'TOFU' | 'MOFU' | 'BOFU';

export type RaceStage = 'REACH' | 'ACT' | 'CONVERT' | 'ENGAGE';

export type SubScores = {
  hookStopScroll: number;
  audienceRelevance: number;
  valueClarity: number;
  trustProofStrength: number;
  ctaClarity: number;
  visualHierarchy?: number;
  productClarity?: number;
  offerClarity?: number;
  headlineStrength?: number;
  descriptionUsefulness?: number;
  ctaVisibility?: number;
  trustSignals?: number;
  firstThreeSeconds?: number;
  soundOffDesign?: number;
  soundOnEnhancement?: number;
  onScreenText?: number;
  storyFlow?: number;
  authenticity?: number;
  platformNativeFeel?: number;
};

export type AidaMapping = {
  attention: string;
  interest: string;
  desire: string;
  action: string;
};

export type AnalysisOutput = {
  overallScore: number;
  qualified: boolean;
  subScores: SubScores;
  creativeAnalysis: string;
  copyAnalysis: string;
  headlineAnalysis: string;
  descriptionAnalysis: string;
  aida: AidaMapping;
  funnelStage: FunnelStage;
  raceStage: RaceStage;
  strengths: string[];
  weaknesses: string[];
  improvements: string[];
};

export type AnalyseInput = {
  row: ExampleRow;
  format: AdFormat;
};
