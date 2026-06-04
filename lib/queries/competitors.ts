import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';

export type CompetitorsFilter = {
  clientId?: string;
  industryId?: string;
  status?: string;
  limit?: number;
  offset?: number;
};

export type MetaConfigUpdate = {
  facebookPageUrl?: string | null;
  metaPageId?: string | null;
};

export type MetaReadyCompetitor = {
  id: string;
  name: string;
  facebookPageUrl: string | null;
  metaPageId: string;
  lastScannedAt: Date | null;
  client: { name: string } | null;
  industry: { name: string } | null;
  latestScanRun: {
    id: string;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
    newAdsFound: number;
    adsUnchanged: number;
  } | null;
  totalMetaAdCount: number;
  pendingMetaAdCount: number;
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

export async function getMetaReadyCompetitors(): Promise<MetaReadyCompetitor[]> {
  const competitors = await db.competitor.findMany({
    where: {
      metaPageId: {
        not: null,
      },
      NOT: {
        metaPageId: '',
      },
    },
    select: {
      id: true,
      name: true,
      facebookPageUrl: true,
      metaPageId: true,
      lastScannedAt: true,
      client: { select: { name: true } },
      industry: { select: { name: true } },
      _count: {
        select: {
          ads: {
            where: { adSource: 'meta_api' },
          },
        },
      },
      scanRuns: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
          newAdsFound: true,
          adsUnchanged: true,
        },
      },
    },
    orderBy: [
      { lastScannedAt: { sort: 'asc', nulls: 'first' } },
      { name: 'asc' },
    ],
  });

  if (competitors.length === 0) return [];

  const competitorIds = competitors.map((competitor) => competitor.id);
  const pendingGroups = await db.ad.groupBy({
    by: ['competitorId'],
    where: {
      competitorId: { in: competitorIds },
      adSource: 'meta_api',
      reviewStatus: 'PENDING',
    },
    _count: { _all: true },
  });

  const pendingCountByCompetitorId = new Map(
    pendingGroups.map((group) => [group.competitorId, group._count._all]),
  );

  return competitors.map((competitor) => ({
    id: competitor.id,
    name: competitor.name,
    facebookPageUrl: competitor.facebookPageUrl,
    metaPageId: competitor.metaPageId!,
    lastScannedAt: competitor.lastScannedAt,
    client: competitor.client,
    industry: competitor.industry,
    latestScanRun: competitor.scanRuns[0] ?? null,
    totalMetaAdCount: competitor._count.ads,
    pendingMetaAdCount: pendingCountByCompetitorId.get(competitor.id) ?? 0,
  }));
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

/**
 * Returns ALL ads for a competitor (not just qualified), ranked by the competitor
 * benchmark score. SQLite sorts NULL lowest, so `competitorBenchmarkScore: 'desc'`
 * places not-yet-scored ads last automatically; the secondary `score` sort keeps
 * ordering stable among them. Internal QA `score`/`qualified` are returned for the
 * small "for comparison" line on the page, not as the primary score.
 */
export function getCompetitorAdsRanked(competitorId: string, limit = 200) {
  return db.ad.findMany({
    where: { competitorId },
    select: {
      id: true,
      metaAdId: true,
      adFormat: true,
      headline: true,
      adLink: true,
      score: true,
      qualified: true,
      competitorBenchmarkScore: true,
      benchmarkTier: true,
      benchmarkConfidence: true,
      evidenceSource: true,
      creativeSource: true,
      benchmarkScoredAt: true,
    },
    orderBy: [{ competitorBenchmarkScore: 'desc' }, { score: 'desc' }],
    take: limit,
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

export function findMetaPageIdConflict(metaPageId: string, currentCompetitorId: string) {
  return db.competitor.findFirst({
    where: {
      metaPageId,
      id: { not: currentCompetitorId },
    },
    select: {
      id: true,
      name: true,
    },
  });
}

export function updateCompetitorMetaConfig(
  id: string,
  data: MetaConfigUpdate,
) {
  return db.competitor.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      facebookPageUrl: true,
      metaPageId: true,
      lastScannedAt: true,
      updatedAt: true,
    },
  });
}
