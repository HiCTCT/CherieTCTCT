-- AlterTable
ALTER TABLE "Ad" ADD COLUMN "capturedAssetPath" TEXT;
ALTER TABLE "Ad" ADD COLUMN "capturedAssetType" TEXT;
ALTER TABLE "Ad" ADD COLUMN "inactiveDetectedAt" DATETIME;
ALTER TABLE "Ad" ADD COLUMN "lastCheckedAt" DATETIME;
ALTER TABLE "Ad" ADD COLUMN "lastSeenActiveAt" DATETIME;
