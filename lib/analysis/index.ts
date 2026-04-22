import { analyseStaticAd } from '@/lib/analysis/staticAnalyser';
import { analyseVideoAd } from '@/lib/analysis/videoAnalyser';
import type { AdFormat, AnalysisOutput, ExampleRow } from '@/lib/analysis/types';

export function analyseAdRow(row: ExampleRow, format: AdFormat): AnalysisOutput {
  if (format === 'VIDEO') {
    return analyseVideoAd(row);
  }

  return analyseStaticAd(row);
}
