import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';

export type CompetitorsFilter = {
  clientId?: string;
  industryId?: string;
  status?: string;
  limit?: number;
  offset?: number;
};

export function getCompetitors(filter: CompetitorsFilter = {}) {
  const where: Prisma.CompetitorWhereInput = {};

  if (filter.clientId) where.clientId = filter.clientId;
  if (filter.industryId) where.industryId = filter.industryId;
  if (filter.status) where.status = filter.status;

  return db.competitor.findMany({
    where,
    include: {
      client: true,
      industry: true,
      _count: {
        select: {
          ads: true,
          scanRuns: true,
        },
      },
    },
    orderBy: { name: 'asc' },
    take: filter.limit ?? 50,
    skip: filter.offset ?? 0,
  });
}

export function getCompetitorById(id: string) {
  return db.competitor.findUnique({
    where: { id },
    include: {
      client: true,
      industry: true,
      ads: {
        where: { qualified: true },
        include: { analysis: true },
        orderBy: { score: 'desc' },
        take: 10,
      },
      _count: {
        select: {
          ads: true,
          scanRuns: true,
        },
      },
    },
  });
}

export function getCompetitorWithScanHistory(id: string) {
  return db.competitor.findUnique({
    where: { id },
    include: {
      client: true,
      industry: true,
      scanRuns: {
        orderBy: { startedAt: 'desc' },
        take: 20,
      },
      _count: {
        select: { ads: true },
      },
    },
  });
}

export function getCompetitorsWithQualifiedAds() {
  return db.competitor.findMany({
    where: {
      ads: { some: { qualified: true } },
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}
