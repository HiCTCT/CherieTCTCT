-- Phase 3.5: Add conversion-focused scoring fields to AdAnalysis
-- All columns are nullable for full backwards compatibility with existing rows.

ALTER TABLE "AdAnalysis" ADD COLUMN "copyScore" REAL;
ALTER TABLE "AdAnalysis" ADD COLUMN "headlineScore" REAL;
ALTER TABLE "AdAnalysis" ADD COLUMN "descriptionScore" REAL;
ALTER TABLE "AdAnalysis" ADD COLUMN "creativeScore" REAL;
ALTER TABLE "AdAnalysis" ADD COLUMN "aidaAttentionScore" REAL;
ALTER TABLE "AdAnalysis" ADD COLUMN "aidaInterestScore" REAL;
ALTER TABLE "AdAnalysis" ADD COLUMN "aidaDesireScore" REAL;
ALTER TABLE "AdAnalysis" ADD COLUMN "aidaActionScore" REAL;
ALTER TABLE "AdAnalysis" ADD COLUMN "clarityScore" REAL;
ALTER TABLE "AdAnalysis" ADD COLUMN "connectionScore" REAL;
ALTER TABLE "AdAnalysis" ADD COLUMN "convictionScore" REAL;
ALTER TABLE "AdAnalysis" ADD COLUMN "trustFunnelStage" TEXT;
ALTER TABLE "AdAnalysis" ADD COLUMN "behaviouralTriggersJson" TEXT;
ALTER TABLE "AdAnalysis" ADD COLUMN "recommendationsJson" TEXT;
ALTER TABLE "AdAnalysis" ADD COLUMN "rewriteDirectionJson" TEXT;
ALTER TABLE "AdAnalysis" ADD COLUMN "finalVerdict" TEXT;
