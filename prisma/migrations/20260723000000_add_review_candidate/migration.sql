-- CreateTable
CREATE TABLE "ReviewCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateKey" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalAdId" TEXT,
    "firstCollectionSource" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "reviewState" TEXT NOT NULL,
    "reviewDecision" TEXT,
    "promotionStatus" TEXT NOT NULL DEFAULT 'NOT_PROMOTED',
    "exceptionsJson" TEXT NOT NULL DEFAULT '[]',
    "visualConfidence" TEXT,
    "promotionPayloadJson" TEXT,
    "payloadSchemaVersion" INTEGER,
    "payloadSha256" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" DATETIME,
    "reviewNote" TEXT,
    "promotedAdId" TEXT,
    "lastPromotionAttemptAt" DATETIME,
    "lastPromotionOutcome" TEXT,
    "lastPromotionError" TEXT,
    "identityConflictJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ReviewCandidate_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReviewCandidate_promotedAdId_fkey" FOREIGN KEY ("promotedAdId") REFERENCES "Ad" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewCandidate_candidateKey_key" ON "ReviewCandidate"("candidateKey");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewCandidate_promotedAdId_key" ON "ReviewCandidate"("promotedAdId");

-- CreateIndex
CREATE INDEX "ReviewCandidate_reviewState_idx" ON "ReviewCandidate"("reviewState");

-- CreateIndex
CREATE INDEX "ReviewCandidate_externalAdId_idx" ON "ReviewCandidate"("externalAdId");

-- CreateIndex
CREATE INDEX "ReviewCandidate_competitorId_idx" ON "ReviewCandidate"("competitorId");

-- CreateIndex
CREATE INDEX "ReviewCandidate_promotionStatus_idx" ON "ReviewCandidate"("promotionStatus");
