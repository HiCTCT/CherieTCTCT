import { NextRequest, NextResponse } from 'next/server';
import { getAds } from '@/lib/queries/ads';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const industryId = params.get('industryId') ?? undefined;
  const competitorId = params.get('competitorId') ?? undefined;
  const format = params.get('format') ?? undefined;

  const qualifiedParam = params.get('qualified');
  const qualified =
    qualifiedParam === 'true' ? true : qualifiedParam === 'false' ? false : undefined;

  const limitParam = params.get('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 100) : 50;

  const offsetParam = params.get('offset');
  const offset = offsetParam ? Math.max(parseInt(offsetParam, 10) || 0, 0) : 0;

  const ads = await getAds({ industryId, competitorId, qualified, format, limit, offset });

  return NextResponse.json({ count: ads.length, limit, offset, results: ads });
}
