import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';

export type ScanRunsFilter = {
  competitorId?: string;
  status?: string;
  limit?: number;
  offset?: number;
};

export function getScanRuns(filter: ScanRunsFilter = {}) {
  const where: Prisma.ScanRunWhereInput = {};

  if (filter.competitorId) where.competitorId = filter.competitorId;
  if (filter.status) where.status = filter.status;

  return db.scanRun.findMany({
    where,
    include: {
      competitor: {
        select: { id: true, name: true },
      },
    },
    orderBy: { startedAt: 'desc' },
    take: filter.limit ?? 50,
    skip: filter.offset ?? 0,
  });
}

export function getScanRunById(id: string) {
  return db.scanRun.findUnique({
    where: { id },
    include: {
      competitor: {
        select: { id: true, name: true },
      },
      adScanRecords: {
        include: {
          ad: {
            select: {
              id: true,
              adFormat: true,
              productOrService: true,
              headline: true,
              score: true,
              qualified: true,
              adStatus: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
}

export function getLatestScanRun(competitorId: string) {
  return db.scanRun.findFirst({
    where: { competitorId },
    include: {
      competitor: {
        select: { id: true, name: true },
      },
    },
    orderBy: { startedAt: 'desc' },
  });
}
