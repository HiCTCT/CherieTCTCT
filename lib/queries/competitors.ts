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

export type CompetitorAdsSort = 'benchmark' | 'newest' | 'longestRunning';

export type CompetitorAdsFilter = {
  benchmarkTier?: string;       // STRONG | MODERATE | WEAK | LOW
  benchmarkConfidence?: string; // HIGH | MEDIUM | LOW
  creativeSource?: string;      // ASSET | MANUAL | FALLBACK
  adFormat?: string;            // STATIC | VIDEO
  sort?: CompetitorAdsSort;
  limit?: number;
};

/**
 * Returns ALL ads for a competitor (not just qualified), filtered + sorted for the
 * competitor detail page.
 *
 * Default sort (`benchmark`) ranks by competitorBenchmarkScore desc then internal
 * score desc. SQLite sorts NULL lowest, so on a `desc` sort not-yet-scored ads land
 * last automatically. Internal QA `score`/`qualified` are returned only for the
 * small "for comparison" line, not as the primary score.
 *
 * Sort options:
 *   benchmark       — competitorBenchmarkScore desc, then score desc (default)
 *   newest          — activeSince desc, then firstSeenAt desc
 *   longestRunning  — activeSince asc, then competitorBenchmarkScore desc
 *
 * (Note: on SQLite, `activeSince asc` places NULL activeSince first; ads missing a
 * start date will appear at the top of "longest-running". Most browser-collected ads
 * carry activeSince, so this is a minor edge case.)
 */
export function getCompetitorAdsRanked(competitorId: string, filter: CompetitorAdsFilter = {}) {
  const where: Prisma.AdWhereInput = { competitorId };
  if (filter.benchmarkTier)       where.benchmarkTier = filter.benchmarkTier;
  if (filter.benchmarkConfidence) where.benchmarkConfidence = filter.benchmarkConfidence;
  if (filter.creativeSource)      where.creativeSource = filter.creativeSource;
  if (filter.adFormat)            where.adFormat = filter.adFormat;

  let orderBy: Prisma.AdOrderByWithRelationInput[];
  switch (filter.sort) {
    case 'newest':
      orderBy = [{ activeSince: 'desc' }, { firstSeenAt: 'desc' }];
      break;
    case 'longestRunning':
      orderBy = [{ activeSince: 'asc' }, { competitorBenchmarkScore: 'desc' }];
      break;
    case 'benchmark':
    default:
      orderBy = [{ competitorBenchmarkScore: 'desc' }, { score: 'desc' }];
  }

  return db.ad.findMany({
    where,
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
    orderBy,
    take: filter.limit ?? 200,
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
