import { PrismaClient } from '@prisma/client';
import {
  loadAgencyAccounts,
  loadStaticExamples,
  loadVideoExamples,
  slugify,
} from '@/lib/data/manualExamples';
import { ingestExampleRows } from '@/lib/ingestion/manualIngestion';

const prisma = new PrismaClient();

async function main() {
  const agencyRows = await loadAgencyAccounts();
  const staticRows = await loadStaticExamples();
  const videoRows = await loadVideoExamples();

  for (const row of agencyRows) {
    const slug = slugify(row.Industry);

    const industry = await prisma.industry.upsert({
      where: { slug },
      create: { name: row.Industry, slug },
      update: { name: row.Industry },
    });

    await prisma.client.upsert({
      where: { name: row.account_name },
      create: {
        name: row.account_name,
        industryId: industry.id,
        whatTheySell: row['What do they sell?'] ?? null,
      },
      update: {
        industryId: industry.id,
        whatTheySell: row['What do they sell?'] ?? null,
      },
    });
  }

  const firstClient = await prisma.client.findFirst({
    include: { industry: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!firstClient) {
    throw new Error('No clients inserted.');
  }

  const competitor = await prisma.competitor.upsert({
    where: {
      name_clientId: {
        name: 'Seed Competitor',
        clientId: firstClient.id,
      },
    },
    create: {
      name: 'Seed Competitor',
      clientId: firstClient.id,
      industryId: firstClient.industryId,
      status: 'APPROVED',
      discoverySource: 'seed',
    },
    update: {
      status: 'APPROVED',
      discoverySource: 'seed',
    },
  });

  // Clean up existing scan records, analyses, and ads for this competitor
  await prisma.adScanRecord.deleteMany({
    where: { ad: { competitorId: competitor.id } },
  });

  await prisma.scanRun.deleteMany({
    where: { competitorId: competitor.id },
  });

  await prisma.adAnalysis.deleteMany({
    where: {
      ad: { competitorId: competitor.id },
    },
  });

  await prisma.ad.deleteMany({
    where: { competitorId: competitor.id },
  });

  // Create a ScanRun to record this seed ingestion
  const scanRun = await prisma.scanRun.create({
    data: {
      competitorId: competitor.id,
      source: 'SEED',
      status: 'RUNNING',
    },
  });

  const staticResult = await ingestExampleRows({
    prisma,
    rows: staticRows,
    format: 'STATIC',
    clientId: firstClient.id,
    industryId: firstClient.industryId,
    competitorId: competitor.id,
    scanRunId: scanRun.id,
  });

  const videoResult = await ingestExampleRows({
    prisma,
    rows: videoRows,
    format: 'VIDEO',
    clientId: firstClient.id,
    industryId: firstClient.industryId,
    competitorId: competitor.id,
    scanRunId: scanRun.id,
  });

  const totalInserted = staticResult.inserted + videoResult.inserted;

  // Update ScanRun with final counts and status
  await prisma.scanRun.update({
    where: { id: scanRun.id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      newAdsFound: totalInserted,
      adsRemoved: 0,
      adsUnchanged: 0,
    },
  });

  // Update Competitor lastScannedAt
  await prisma.competitor.update({
    where: { id: competitor.id },
    data: { lastScannedAt: new Date() },
  });

  console.log('Seed complete');
  console.log(JSON.stringify({ staticResult, videoResult, scanRunId: scanRun.id }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
