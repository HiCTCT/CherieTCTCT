import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function ok(label: string, details?: unknown) {
  console.log(`✅ PASS: ${label}`);
  if (details) console.log(JSON.stringify(details, null, 2));
}

function no(label: string, details?: unknown) {
  console.log(`❌ FAIL: ${label}`);
  if (details) console.log(JSON.stringify(details, null, 2));
}

async function run() {
  let fails = 0;

  const counts = {
    industries: await prisma.industry.count(),
    clients: await prisma.client.count(),
    competitors: await prisma.competitor.count(),
    ads: await prisma.ad.count(),
    ad_analysis: await prisma.adAnalysis.count(),
  };

  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) ok(`${k} inserted (${v})`);
    else {
      no(`${k} missing`);
      fails += 1;
    }
  }

  const chain = await prisma.ad.findFirst({
    where: { qualified: true },
    include: { industry: true, client: true, competitor: true, analysis: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!chain || !chain.analysis) {
    no('No qualified ad with analysis found');
    fails += 1;
  } else {
    const relationOk =
      chain.client.industryId === chain.industry.id &&
      chain.competitor.clientId === chain.client.id &&
      chain.competitor.industryId === chain.industry.id &&
      chain.analysis.adId === chain.id;

    if (relationOk) {
      ok('Relations are correct');
      console.log('\nExample record chain:');
      console.log(
        JSON.stringify(
          {
            industry: { id: chain.industry.id, name: chain.industry.name },
            client: { id: chain.client.id, name: chain.client.name },
            competitor: { id: chain.competitor.id, name: chain.competitor.name },
            ad: { id: chain.id, adLink: chain.adLink, score: chain.score, qualified: chain.qualified },
            ad_analysis: {
              id: chain.analysis.id,
              overallScore: chain.analysis.overallScore,
              funnelStage: chain.analysis.funnelStage ?? "N/A",
              raceStage: chain.analysis.raceStage ?? "N/A",
            },
          },
          null,
          2,
        ),
      );
    } else {
      no('Relation chain incorrect');
      fails += 1;
    }
  }

  const below = await prisma.ad.count({ where: { qualified: true, score: { lt: 7 } } });
  if (below === 0) ok('No qualified ads below 7.0 were saved');
  else {
    no('Found qualified ads below 7.0', { count: below });
    fails += 1;
  }

  const missingStructuredAnalysis = await prisma.adAnalysis.count({
    where: {
      OR: [{ funnelStage: '' }, { raceStage: '' }, { aidaJson: '' }, { rubricScoresJson: '' }],
    },
  });

  if (missingStructuredAnalysis === 0) {
    ok('Structured analysis fields are populated');
  } else {
    no('Structured analysis fields missing for one or more rows', { count: missingStructuredAnalysis });
    fails += 1;
  }

  const dashboardLatest = await prisma.ad.findMany({
    where: { qualified: true },
    orderBy: { score: 'desc' },
    take: 5,
    include: { competitor: true, industry: true, analysis: true },
  });
  if (dashboardLatest.length > 0) {
    ok(
      'Dashboard proof (latest seeded qualified ads)',
      dashboardLatest.map((ad) => ({
        id: ad.id,
        competitor: ad.competitor.name,
        industry: ad.industry.name,
        score: ad.score,
        funnelStage: ad.analysis?.funnelStage ?? "N/A",
      })),
    );
  } else {
    no('Dashboard proof failed (no qualified ads)');
    fails += 1;
  }

  if (dashboardLatest.length > 0) {
    const detail = await prisma.ad.findUnique({
      where: { id: dashboardLatest[0].id },
      include: { analysis: true, competitor: true },
    });
    if (detail?.analysis) {
      ok('Ad detail proof (real analysed saved ad)', {
        adId: detail.id,
        competitor: detail.competitor.name,
        score: detail.score,
        analysisId: detail.analysis.id,
        creativeAnalysis: detail.analysis.creativeAnalysis,
      });
    } else {
      no('Ad detail proof failed (analysis missing)');
      fails += 1;
    }
  }

  console.log('\nFinal inserted counts:');
  console.log(JSON.stringify(counts, null, 2));

  if (fails > 0) {
    console.log(`\n❌ Runtime verification failed with ${fails} failing checks.`);
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
