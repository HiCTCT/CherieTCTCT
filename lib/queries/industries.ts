import { db } from '@/lib/db';

export function getIndustries() {
  return db.industry.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: {
          clients: true,
          ads: true,
        },
      },
    },
  });
}

export function getIndustriesWithQualifiedAds() {
  return db.industry.findMany({
    where: {
      ads: { some: { qualified: true } },
    },
    select: { slug: true, name: true },
    orderBy: { name: 'asc' },
  });
}

export function getIndustryBySlug(slug: string) {
  return db.industry.findUnique({
    where: { slug },
    include: {
      clients: {
        orderBy: { name: 'asc' },
      },
      ads: {
        where: { qualified: true },
        include: {
          competitor: true,
          analysis: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  });
}
