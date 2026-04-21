import { PrismaClient } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

const prisma = new PrismaClient();
const root = process.cwd();

type AgencyRow = {
  account_name: string;
  Industry: string;
  'What do they sell?'?: string;
};

type ExampleRow = {
  Product: string;
  'Ad Link'?: string;
  Copy?: string;
  Headline?: string;
  Description?: string;
  Analysis?: string;
  Improvement?: string;
  'Creative Analysis'?: string;
  'Active Since'?: string;
};

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

function scoreRow(row: ExampleRow, format: 'STATIC' | 'VIDEO'): number {
  const copy = row.Copy ?? '';
  const headline = row.Headline ?? '';
  const description = row.Description ?? '';
  const analysis = `${row.Analysis ?? ''} ${row['Creative Analysis'] ?? ''}`;

  let score = 5.5;
  if (copy.length > 40) score += 0.8;
  if (headline.length > 8) score += 0.6;
  if (/book|start|get started|learn more|shop|register/i.test(`${headline} ${description}`)) score += 0.8;
  if (/trust|proof|testimonial|results|benefit|value/i.test(`${copy} ${analysis}`)) score += 0.6;
  if (format === 'VIDEO' && /hook|caption|0-3|stop-scroll|reels|tiktok/i.test(analysis)) score += 0.9;

  return Number(Math.min(10, score).toFixed(2));
}

async function loadCsv<T>(relativePath: string): Promise<T[]> {
  const filePath = path.join(root, relativePath);
  const content = await readFile(filePath, 'utf8');
  return parse(content, { columns: true, skip_empty_lines: true, trim: true }) as T[];
}

async function main() {
  const agencyRows = await loadCsv<AgencyRow>('meta-ad-library/Agency Accounts Overview.csv');
  const staticRows = await loadCsv<ExampleRow>('meta-ad-library/Static Ad Library example.csv');
  const videoRows = await loadCsv<ExampleRow>('meta-ad-library/Meta Video Ad Library example.csv');

  for (const row of agencyRows) {
    const slug = slugify(row.Industry);

    const industry = await prisma.industry.upsert({
      where: { slug },
      create: { name: row.Industry, slug },
      update: { name: row.Industry }
    });

    await prisma.client.upsert({
      where: { name: row.account_name },
      create: {
        name: row.account_name,
        industryId: industry.id,
        whatTheySell: row['What do they sell?'] ?? null
      },
      update: {
        industryId: industry.id,
        whatTheySell: row['What do they sell?'] ?? null
      }
    });
  }

  const firstClient = await prisma.client.findFirst({
    include: { industry: true },
    orderBy: { createdAt: 'asc' }
  });

  if (!firstClient) {
    throw new Error('No clients inserted.');
  }

  const competitor = await prisma.competitor.upsert({
    where: {
      name_clientId: {
        name: 'Seed Competitor',
        clientId: firstClient.id
      }
    },
    create: {
      name: 'Seed Competitor',
      clientId: firstClient.id,
      industryId: firstClient.industryId,
      status: 'APPROVED',
      discoverySource: 'seed'
    },
    update: {
      status: 'APPROVED',
      discoverySource: 'seed'
    }
  });

  await prisma.adAnalysis.deleteMany({
    where: {
      ad: { competitorId: competitor.id }
    }
  });

  await prisma.ad.deleteMany({
    where: { competitorId: competitor.id }
  });

  const ingestRows = async (rows: ExampleRow[], format: 'STATIC' | 'VIDEO') => {
    let processed = 0;
    let inserted = 0;
    let rejectedBelow7 = 0;

    for (const row of rows) {
      processed += 1;
      const score = scoreRow(row, format);
      const qualified = score >= 7;

      if (!qualified) {
        rejectedBelow7 += 1;
        continue;
      }

      const ad = await prisma.ad.create({
        data: {
          clientId: firstClient.id,
          industryId: firstClient.industryId,
          competitorId: competitor.id,
          productOrService: row.Product,
          adFormat: format,
          adLink: row['Ad Link'] ?? `https://www.facebook.com/ads/library/?id=seed-${processed}`,
          activeSince: row['Active Since'] ? new Date(row['Active Since']) : undefined,
          primaryCopy: row.Copy,
          headline: row.Headline,
          description: row.Description,
          score,
          qualified
        }
      });

      await prisma.adAnalysis.create({
        data: {
          adId: ad.id,
          creativeAnalysis: row['Creative Analysis'] ?? row.Analysis ?? 'Seeded analysis.',
          copyAnalysis: row.Copy ? 'Copy present and reviewed.' : 'Copy missing.',
          headlineAnalysis: row.Headline ? 'Headline present and reviewed.' : 'Headline missing.',
          descriptionAnalysis: row.Description ? 'Description present and reviewed.' : 'Description missing.',
          strengthsJson: JSON.stringify(['Clear structure']),
          weaknessesJson: JSON.stringify(['Manual seed baseline']),
          improvementsJson: JSON.stringify([row.Improvement ?? 'Add stronger CTA.']),
          rubricScoresJson: JSON.stringify({ score }),
          overallScore: score
        }
      });

      inserted += 1;
    }

    return { processed, inserted, rejectedBelow7 };
  };

  const staticResult = await ingestRows(staticRows, 'STATIC');
  const videoResult = await ingestRows(videoRows, 'VIDEO');

  console.log('Seed complete');
  console.log(JSON.stringify({ staticResult, videoResult }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
