import { PrismaClient } from '@prisma/client';
import { loadAgencyAccounts, loadStaticExamples, loadVideoExamples, slugify } from '@/lib/data/manualExamples';
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

  await prisma.adAnalysis.deleteMany({
    where: {
      ad: { competitorId: competitor.id },
    },
  });

  await prisma.ad.deleteMany({
    where: { competitorId: competitor.id },
  });

  const staticResult = await ingestExampleRows({
    prisma,
    rows: staticRows,
    format: 'STATIC',
    clientId: firstClient.id,
    industryId: firstClient.industryId,
    competitorId: competitor.id,
  });

  const videoResult = await ingestExampleRows({
    prisma,
    rows: videoRows,
    format: 'VIDEO',
    clientId: firstClient.id,
    industryId: firstClient.industryId,
    competitorId: competitor.id,
  });

  console.log('Seed complete');
  console.log(
    JSON.stringify(
      {
        staticResult,
        videoResult,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
