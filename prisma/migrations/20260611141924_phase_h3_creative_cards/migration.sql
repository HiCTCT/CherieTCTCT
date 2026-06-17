-- CreateTable
CREATE TABLE "AdCreativeCard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adId" TEXT NOT NULL,
    "cardIndex" INTEGER NOT NULL,
    "assetPath" TEXT,
    "mediaType" TEXT NOT NULL,
    "headline" TEXT,
    "description" TEXT,
    "cta" TEXT,
    "displayUrl" TEXT,
    "landingUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AdCreativeCard_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AdCreativeCard_adId_idx" ON "AdCreativeCard"("adId");

-- CreateIndex
CREATE UNIQUE INDEX "AdCreativeCard_adId_cardIndex_key" ON "AdCreativeCard"("adId", "cardIndex");
