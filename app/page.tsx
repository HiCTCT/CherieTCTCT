import Link from 'next/link';
import { Suspense } from 'react';
import { getDashboardCounts, getAllAds } from '@/lib/queries/ads';
import { getAllIndustriesForFilter } from '@/lib/queries/industries';
import DashboardFilter from '@/app/components/DashboardFilter';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: {
    industry?: string;
    q?: string;
    qualified?: string;
    source?: string;
    format?: string;
    score?: string;
  };
}) {
  const industrySlug   = searchParams.industry  || '';
  const searchTerm     = searchParams.q         || '';
  const qualifiedParam = searchParams.qualified ?? '';   // '' = default -> true
  const sourceParam    = searchParams.source    || '';
  const formatParam    = searchParams.format    || '';
  const scoreParam     = searchParams.score     || '';

  // Qualified filter — default (no param) = qualified=true
  const qualified: boolean | undefined =
    qualifiedParam === 'all'   ? undefined :
    qualifiedParam === 'false' ? false     :
    true;

  // Score range
  let scoreMin: number | undefined;
  let scoreMax: number | undefined;
  if (scoreParam === 'high')     { scoreMin = 7.0; }
  else if (scoreParam === 'mid') { scoreMin = 5.0; scoreMax = 7.0; }
  else if (scoreParam === 'low') { scoreMax = 5.0; }

  // Heading
  const heading =
    qualifiedParam === 'all' || qualifiedParam === 'false' ? 'Ads' : 'Latest qualified ads';

  const [industryCount, clientCount, qualifiedAdCount] = await getDashboardCounts();
  const industries = await getAllIndustriesForFilter();

  const ads = await getAllAds({
    limit:        24,
    industrySlug: industrySlug  || undefined,
    search:       searchTerm    || undefined,
    qualified,
    adSource:     sourceParam   || undefined,
    format:       formatParam   || undefined,
    scoreMin,
    scoreMax,
  });

  return (
    <section>
      <h1>Meta Competitor Ad Library</h1>

      <div className="card">
        <p><strong>Industries:</strong> {industryCount}</p>
        <p><strong>Clients:</strong> {clientCount}</p>
        <p><strong>Qualified ads:</strong> {qualifiedAdCount}</p>
      </div>

      <div className="card">
        <h2>Browse</h2>
        <p>
          <Link href="/industries">→ Browse industries</Link>
        </p>
        <p>
          <Link href="/competitors">→ Browse competitors</Link>
        </p>
      </div>

      <h2>{heading}</h2>

      <Suspense fallback={<p>Loading filters...</p>}>
        <DashboardFilter
          industries={industries}
          currentIndustry={industrySlug}
          currentSearch={searchTerm}
          currentQualified={qualifiedParam || 'true'}
          currentSource={sourceParam}
          currentFormat={formatParam}
          currentScore={scoreParam}
        />
      </Suspense>

      {ads.length === 0 ? (
        <div className="card">
          <p>No ads found for the selected filters.</p>
        </div>
      ) : (
        ads.map((ad) => (
          <div className="card" key={ad.id}>
            <p>
              <strong>{ad.competitor.name}</strong> &middot; {ad.industry.name}
            </p>
            <p>
              Format: <strong>{ad.adFormat}</strong>
              {' · '}Score <strong>{ad.score.toFixed(1)}</strong> / 10
              {' · '}
              <span
                style={{
                  display: 'inline-block',
                  padding: '2px 8px',
                  borderRadius: '10px',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: ad.qualified ? '#dbeafe' : '#f1f5f9',
                  color:      ad.qualified ? '#1e40af' : '#64748b',
                }}
              >
                {ad.qualified ? 'Qualified' : 'Not qualified'}
              </span>
              {ad.adSource === 'browser_collected' && (
                <span
                  style={{
                    display: 'inline-block',
                    marginLeft: '6px',
                    padding: '2px 8px',
                    borderRadius: '10px',
                    fontSize: '12px',
                    fontWeight: 600,
                    background: '#f0fdf4',
                    color: '#166534',
                  }}
                >
                  browser
                </span>
              )}
            </p>
            <p>
              <Link href={`/ads/${ad.id}`}>Open ad detail</Link>
            </p>
          </div>
        ))
      )}
    </section>
  );
}
