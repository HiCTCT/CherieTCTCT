import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type VerificationCheck = {
  name: string;
  description: string;
  violations: string[];
};

function passOrFail(check: VerificationCheck): void {
  if (check.violations.length === 0) {
    console.log(`✅ PASS: ${check.name}`);
    console.log(`   ${check.description}`);
    return;
  }

  console.log(`❌ FAIL: ${check.name}`);
  console.log(`   ${check.description}`);
  console.log(`   Violations: ${check.violations.length}`);
  for (const violation of check.violations.slice(0, 10)) {
    console.log(`   - ${violation}`);
  }
  if (check.violations.length > 10) {
    console.log(`   ...and ${check.violations.length - 10} more`);
  }
}

function normaliseStatus(status: string | null): string {
  return status ?? 'NULL';
}

function buildChecklist(competitorId: string | undefined): string[] {
  const competitorPrefix = competitorId ? `COMPETITOR_ID=${competitorId} ` : 'COMPETITOR_ID=<cuid> ';

  return [
    `${competitorPrefix}META_DRY_RUN=true npm run meta:ingest`,
    `${competitorPrefix}META_FETCH_LIMIT=5 npm run meta:ingest`,
    `${competitorPrefix}npm run meta:verify`,
    `${competitorPrefix}META_FETCH_LIMIT=5 npm run meta:ingest`,
    `${competitorPrefix}npm run meta:verify`,
    competitorId
      ? `Open http://localhost:3000/meta-review?competitorId=${competitorId}`
      : 'Open http://localhost:3000/meta-review?competitorId=<cuid>',
    'Open http://localhost:3000 and confirm pending Meta ads are not in the qualified library',
  ];
}

async function main(): Promise<void> {
  const competitorId = process.env.COMPETITOR_ID?.trim() || undefined;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Phase 4 Step 6 — Meta ingestion safety verification');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Scope: ${competitorId ? `competitor ${competitorId}` : 'all competitors'}`);
  console.log('');

  const ads = await prisma.ad.findMany({
    where: {
      adSource: 'meta_api',
      ...(competitorId ? { competitorId } : {}),
    },
    select: {
      id: true,
      metaAdId: true,
      competitorId: true,
      adSource: true,
      reviewStatus: true,
      qualified: true,
      score: true,
      adLink: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const checks: VerificationCheck[] = [];

  checks.push({
    name: 'Meta API ad source is consistent',
    description: 'Every checked ad must have adSource="meta_api".',
    violations: ads
      .filter((ad) => ad.adSource !== 'meta_api')
      .map((ad) => `${ad.id} has adSource=${ad.adSource}`),
  });

  const allowedStatuses = new Set(['PENDING', 'APPROVED', 'REJECTED']);
  checks.push({
    name: 'Review status is controlled',
    description: 'Every Meta API ad must have reviewStatus PENDING, APPROVED, or REJECTED.',
    violations: ads
      .filter((ad) => !allowedStatuses.has(normaliseStatus(ad.reviewStatus)))
      .map((ad) => `${ad.metaAdId ?? ad.id} has reviewStatus=${normaliseStatus(ad.reviewStatus)}`),
  });

  checks.push({
    name: 'Pending Meta ads cannot enter the qualified library',
    description:
      'Any meta_api ad with reviewStatus="PENDING" must have qualified=false. PENDING ads CANNOT enter the qualified library until explicit approval.',
    violations: ads
      .filter((ad) => ad.reviewStatus === 'PENDING' && ad.qualified)
      .map((ad) => `${ad.metaAdId ?? ad.id} is PENDING but qualified=true`),
  });

  checks.push({
    name: 'Approved high-scoring Meta ads are promoted correctly',
    description: 'Any APPROVED meta_api ad with score >= 7.0 should have qualified=true.',
    violations: ads
      .filter((ad) => ad.reviewStatus === 'APPROVED' && ad.score >= 7.0 && !ad.qualified)
      .map((ad) => `${ad.metaAdId ?? ad.id} is APPROVED with score ${ad.score} but qualified=false`),
  });

  checks.push({
    name: 'Meta ad IDs are present',
    description: 'Every Meta API ad must have a non-empty metaAdId for deduplication.',
    violations: ads
      .filter((ad) => !ad.metaAdId)
      .map((ad) => `${ad.id} has missing metaAdId`),
  });

  checks.push({
    name: 'Competitor links are present',
    description: 'Every Meta API ad must remain linked to a competitor.',
    violations: ads
      .filter((ad) => !ad.competitorId)
      .map((ad) => `${ad.metaAdId ?? ad.id} has missing competitorId`),
  });

  checks.push({
    name: 'Token safety is preserved',
    description: 'No stored Meta API adLink may contain access_token=.',
    violations: ads
      .filter((ad) => ad.adLink.includes('access_token='))
      .map((ad) => `${ad.metaAdId ?? ad.id} has access_token= in adLink`),
  });

  const metaAdIdCounts = new Map<string, number>();
  for (const ad of ads) {
    if (!ad.metaAdId) continue;
    metaAdIdCounts.set(ad.metaAdId, (metaAdIdCounts.get(ad.metaAdId) ?? 0) + 1);
  }
  checks.push({
    name: 'Meta ad IDs are unique',
    description: 'No two checked Meta API ads may share the same metaAdId.',
    violations: Array.from(metaAdIdCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([metaAdId, count]) => `${metaAdId} appears ${count} times`),
  });

  let totalViolations = 0;
  for (const check of checks) {
    passOrFail(check);
    totalViolations += check.violations.length;
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Ads checked:       ${ads.length}`);
  console.log(`  Checks run:        ${checks.length}`);
  console.log(`  Total violations:  ${totalViolations}`);
  console.log(`  Overall result:    ${totalViolations === 0 ? 'PASS' : 'FAIL'}`);
  console.log('');

  console.log('Recommended controlled ingestion checklist:');
  for (const [index, command] of buildChecklist(competitorId).entries()) {
    console.log(`  ${index + 1}. ${command}`);
  }
  console.log('═══════════════════════════════════════════════════════════════');

  if (totalViolations > 0) {
    process.exit(1);
  }
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\n❌ Meta ingestion verification failed:', message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
