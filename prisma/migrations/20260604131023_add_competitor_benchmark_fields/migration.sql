-- AlterTable
ALTER TABLE "Ad" ADD COLUMN "benchmarkConfidence" TEXT;
ALTER TABLE "Ad" ADD COLUMN "benchmarkScoredAt" DATETIME;
ALTER TABLE "Ad" ADD COLUMN "benchmarkTier" TEXT;
ALTER TABLE "Ad" ADD COLUMN "competitorBenchmarkScore" REAL;
ALTER TABLE "Ad" ADD COLUMN "creativeSource" TEXT;
ALTER TABLE "Ad" ADD COLUMN "evidenceSource" TEXT;

-- AlterTable
ALTER TABLE "AdAnalysis" ADD COLUMN "benchmarkBreakdownJson" TEXT;
ALTER TABLE "AdAnalysis" ADD COLUMN "recommendedUse" TEXT;

-- CreateIndex
CREATE INDEX "Ad_competitorId_competitorBenchmarkScore_idx" ON "Ad"("competitorId", "competitorBenchmarkScore");
