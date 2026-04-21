import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function pass(label: string, details?: unknown): void {
  console.log(`✅ PASS: ${label}`);
  if (details !== undefined) {
    console.log(JSON.stringify(details, null, 2));
  }
}

function fail(label: string, details?: unknown): void {
  console.log(`❌ FAIL: ${label}`);
  if (details !== undefined) {
    console.log(JSON.stringify(details, null, 2));
  }
}

async function run(): Promise<void> {
  let failures = 0;

  const counts = {
    industries: await prisma.industry.count(),
    clients: await prisma.client.count(),
    competitors: await prisma.competitor.count(),
    ads: await prisma.ad.count(),
    ad_analysis: await prisma.adAnalysis.count()
  };

  for (const [name, value] of Object.entries(counts)) {
    if (value > 0) {
      pass(`${name} inserted (${value})`);
    } else {
      fail(`${name} missing`);
      failures += 1;
    }
  }

  const chain = await prisma.ad.findFirst({
    where: { qualified: true },
    include: {
      industry: true,
      client: true,
      competitor: true,
      analysis: true
    },
    orderBy: { createdAt: 'asc' }
  });

  if (!chain || !chain.analysis) {
    fail('No qualified ad with analysis found');
    failures += 1;
  } else {
    const relationOk =
      chain.client.industryId === chain.industry.id &&
      chain.competitor.clientId === chain.client.id &&
      chain.competitor.industryId === chain.industry.id &&
      chain.analysis.adId === chain.id;

    if (relationOk) {
      pass('Relations are correct');
      console.log('\nExample record chain:');
      console.log(
        JSON.stringify(
          {
            industry: { id: chain.industry.id, name: chain.industry.name },
            client: { id: chain.client.id, name: chain.client.name },
            competitor: { id: chain.competitor.id, name: chain.competitor.name },
            ad: {
              id: chain.id,
              adLink: chain.adLink,
              score: chain.score,
              qualified: chain.qualified
            },
            ad_analysis: {
              id: chain.analysis.id,
              overallScore: chain.analysis.overallScore
            }
          },
          null,
          2
        )
      );
    } else {
      fail('Relation chain incorrect');
      failures += 1;
    }
  }

  const belowThresholdQualified = await prisma.ad.count({
    where: {
      qualified: true,
      score: { lt: 7 }
    }
  });

  if (belowThresholdQualified === 0) {
    pass('No qualified ads below 7.0 were saved');
  } else {
    fail('Found qualified ads below 7.0', { count: belowThresholdQualified });
    failures += 1;
  }

  const dashboardLatest = await prisma.ad.findMany({
    where: { qualified: true },
    orderBy: { activeSince: 'desc' },
    take: 5,
    include: { competitor: true, industry: true }
  });

  if (dashboardLatest.length > 0) {
    pass(
      'Dashboard proof (latest seeded qualified ads)',
      dashboardLatest.map((ad) => ({
        id: ad.id,
        competitor: ad.competitor.name,
        industry: ad.industry.name,
        score: ad.score
      }))
    );
  } else {
    fail('Dashboard proof failed (no qualified ads)');
    failures += 1;
  }

  if (dashboardLatest.length > 0) {
    const detail = await prisma.ad.findUnique({
      where: { id: dashboardLatest[0].id },
      include: { analysis: true, competitor: true }
    });

    if (detail?.analysis) {
      pass('Ad detail proof (real analysed saved ad)', {
        adId: detail.id,
        competitor: detail.competitor.name,
        score: detail.score,
        analysisId: detail.analysis.id,
        creativeAnalysis: detail.analysis.creativeAnalysis
      });
    } else {
      fail('Ad detail proof failed (analysis missing)');
      failures += 1;
    }
  }

  console.log('\nFinal inserted counts:');
  console.log(JSON.stringify(counts, null, 2));

  if (failures > 0) {
    console.log(`\n❌ Runtime verification failed with ${failures} failing checks.`);
    process.exit(1);
  }

  console.log('\n✅ Runtime verification passed for all checks.');
}

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
