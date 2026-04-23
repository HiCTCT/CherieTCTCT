import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';

export type AdsFilter = {
  industryId?: string;
  competitorId?: string;
  qualified?: boolean;
  format?: string;
  limit?: number;
  offset?: number;
};

export function getAds(filter: AdsFilter = {}) {
  const where: Prisma.AdWhereInput = {};

  if (filter.industryId) where.industryId = filter.industryId;
  if (filter.competitorId) where.competitorId = filter.competitorId;
  if (filter.qualified !== undefined) where.qualified = filter.qualified;
  if (filter.format) where.adFormat = filter.format;

  return db.ad.findMany({
    where,
    include: {
      competitor: true,
      industry: true,
      client: true,
      analysis: true,
    },
    orderBy: { score: 'desc' },
    take: filter.limit ?? 50,
    skip: filter.offset ?? 0,
  });
}

export function getAdById(id: string) {
  return db.ad.findUnique({
    where: { id },
    include: {
      industry: true,
      client: true,
      competitor: true,
      analysis: true,
    },
  });
}

export type QualifiedAdsFilter = {
  limit?: number;
  industrySlug?: string;
  search?: string;
};

export function getQualifiedAds(filter: QualifiedAdsFilter = {}) {
  const where: Prisma.AdWhereInput = { qualified: true };

  if (filter.industrySlug) {
    where.industry = { slug: filter.industrySlug };
  }

  if (filter.search) {
    const term = filter.search;
    where.OR = [
      { competitor: { name: { contains: term } } },
      { productOrService: { contains: term } },
      { headline: { contains: term } },
      { primaryCopy: { contains: term } },
    ];
  }

  return db.ad.findMany({
    where,
    include: {
      competitor: true,
      industry: true,
      analysis: true,
    },
    orderBy: { score: 'desc' },
    take: filter.limit ?? 12,
  });
}

export function getDashboardCounts() {
  return Promise.all([
    db.industry.count(),
    db.client.count(),
    db.ad.count({ where: { qualified: true } }),
  ]);
}
