-- Phase 4 Step 2: Meta Ad ingestion fields
-- Adds deduplication key, source tracking, and review workflow to Ad.
-- Adds metaPageId to Competitor for API-targeted queries.

-- Ad: deduplication key for Meta Ad Library records
ALTER TABLE "Ad" ADD COLUMN "metaAdId" TEXT;
CREATE UNIQUE INDEX "Ad_metaAdId_key" ON "Ad"("metaAdId");

-- Ad: track whether the record came from seed CSV or Meta API
ALTER TABLE "Ad" ADD COLUMN "adSource" TEXT NOT NULL DEFAULT 'seed';

-- Ad: review workflow for API-discovered ads (PENDING | APPROVED | REJECTED)
ALTER TABLE "Ad" ADD COLUMN "reviewStatus" TEXT;

-- Competitor: Meta page ID used to target Ad Library queries
ALTER TABLE "Competitor" ADD COLUMN "metaPageId" TEXT;
