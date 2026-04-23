-- AlterTable
ALTER TABLE "Competitor" ADD COLUMN "facebookPageUrl" TEXT;
ALTER TABLE "Competitor" ADD COLUMN "lastScannedAt" DATETIME;

-- CreateTable
CREATE TABLE "ScanRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "competitorId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "newAdsFound" INTEGER NOT NULL DEFAULT 0,
    "adsRemoved" INTEGER NOT NULL DEFAULT 0,
    "adsUnchanged" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScanRun_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdScanRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adId" TEXT NOT NULL,
    "scanRunId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdScanRecord_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AdScanRecord_scanRunId_fkey" FOREIGN KEY ("scanRunId") REFERENCES "ScanRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Ad" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "industryId" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "productOrService" TEXT,
    "adFormat" TEXT NOT NULL,
    "adLink" TEXT NOT NULL,
    "activeSince" DATETIME,
    "primaryCopy" TEXT,
    "headline" TEXT,
    "description" TEXT,
    "score" REAL NOT NULL,
    "qualified" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" DATETIME,
    "lastSeenAt" DATETIME,
    "adStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Ad_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Ad_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Ad_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Ad" ("activeSince", "adFormat", "adLink", "clientId", "competitorId", "createdAt", "description", "headline", "id", "industryId", "primaryCopy", "productOrService", "qualified", "score", "updatedAt") SELECT "activeSince", "adFormat", "adLink", "clientId", "competitorId", "createdAt", "description", "headline", "id", "industryId", "primaryCopy", "productOrService", "qualified", "score", "updatedAt" FROM "Ad";
DROP TABLE "Ad";
ALTER TABLE "new_Ad" RENAME TO "Ad";
CREATE INDEX "Ad_qualified_score_idx" ON "Ad"("qualified", "score");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "AdScanRecord_adId_scanRunId_key" ON "AdScanRecord"("adId", "scanRunId");
