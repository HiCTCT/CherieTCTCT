import Link from 'next/link';
import { notFound } from 'next/navigation';
import CompetitorMetaConfigForm from '@/app/components/CompetitorMetaConfigForm';
import {
  getCompetitorById,
  getCompetitorWithScanHistory,
  getCompetitorAdsRanked,
} from '@/lib/queries/competitors';
import { getPendingAdCount } from '@/lib/queries/pendingAds';
import {
  tierLabel,
  confidenceLabel,
  evidenceLabel,
  creativeSourceLabel,
} from '@/lib/analysis/competitorScoring';

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getMetaReadiness(metaPageId: string | null, lastScannedAt: Date | null) {
  if (!metaPageId) {
    return {
      label: 'Not ready - Meta page ID missing',
      detail: 'Add a Meta Page ID below to enable competitor-specific Meta ingestion.',
    };
  }

  if (!lastScannedAt) {
    return {
      label: 'Ready - not yet scanned',
      detail: 'This competitor has a Meta Page ID and is ready for its first Meta ingestion run.',
    };
  }

  return {
    label: 'Ready - previously scanned',
    detail: `This competitor has a Meta Page ID and was last scanned on ${formatDate(lastScannedAt)}.`,
  };
}

const tc = (s: string): string => s.charAt(0) + s.slice(1).toLowerCase();

function FilterGroup({
  label,
  paramKey,
  options,
  current,
  buildHref,
  includeAll = true,
}: {
  label: string;
  paramKey: string;
  options: { value: string; label: string }[];
  current: string | undefined;
  buildHref: (o: Record<string, string | undefined>) => string;
  includeAll?: boolean;
}) {
  const style = (active: boolean) => ({ fontWeight: active ? 700 : 400 });
  return (
    <p style={{ margin: '4px 0' }}>
      <strong>{label}:</strong>{' '}
      {includeAll && (
        <Link href={buildHref({ [paramKey]: undefined })} style={style(!current)}>
          All
        </Link>
      )}
      {options.map((o, i) => (
        <span key={o.value}>
          {(includeAll || i > 0) && ' · '}
          <Link href={buildHref({ [paramKey]: o.value })} style={style(current === o.value)}>
            {o.label}
          </Link>
        </span>
      ))}
    </p>
  );
}

export default async function CompetitorDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  // ── Parse + validate filters from the URL ──
  const sp = searchParams ?? {};
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);

  const TIERS = ['STRONG', 'MODERATE', 'WEAK', 'LOW'];
  const CONFS = ['HIGH', 'MEDIUM', 'LOW'];
  const SOURCES = ['ASSET', 'MANUAL', 'FALLBACK'];
  const FORMATS = ['STATIC', 'VIDEO'];
  const SORTS = ['benchmark', 'newest', 'longestRunning'];

  const tier = TIERS.includes(one('tier') ?? '') ? one('tier') : undefined;
  const conf = CONFS.includes(one('confidence') ?? '') ? one('confidence') : undefined;
  const source = SOURCES.includes(one('source') ?? '') ? one('source') : undefined;
  const format = FORMATS.includes(one('format') ?? '') ? one('format') : undefined;
  const sort = (SORTS.includes(one('sort') ?? '') ? one('sort') : 'benchmark') as
    'benchmark' | 'newest' | 'longestRunning';

  const [competitor, competitorWithScans, pendingAdCount, rankedAds] = await Promise.all([
    getCompetitorById(params.id),
    getCompetitorWithScanHistory(params.id),
    getPendingAdCount(params.id),
    getCompetitorAdsRanked(params.id, {
      benchmarkTier: tier,
      benchmarkConfidence: conf,
      creativeSource: source,
      adFormat: format,
      sort,
    }),
  ]);

  if (!competitor) {
    notFound();
  }

  const scanRuns = competitorWithScans?.scanRuns ?? [];
  const metaReadiness = getMetaReadiness(competitor.metaPageId, competitor.lastScannedAt);

  // ── Filter/sort URL helpers ──
  const hasActiveFilters = Boolean(tier || conf || source || format);
  const buildHref = (overrides: Record<string, string | undefined>): string => {
    const merged: Record<string, string | undefined> = {
      tier, confidence: conf, source, format, sort, ...overrides,
    };
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) {
      // Omit empty values and the default sort to keep URLs clean.
      if (v && !(k === 'sort' && v === 'benchmark')) usp.set(k, v);
    }
    const qs = usp.toString();
    return `/competitors/${params.id}${qs ? `?${qs}` : ''}`;
  };

  const activeFilterLabels: string[] = [];
  if (tier) activeFilterLabels.push(`Tier = ${tc(tier)}`);
  if (conf) activeFilterLabels.push(`Confidence = ${tc(conf)}`);
  if (source) activeFilterLabels.push(`Creative source = ${tc(source)}`);
  if (format) activeFilterLabels.push(`Format = ${tc(format)}`);

  // ── Benchmark summary (computed from the ranked ads) ──
  const scoredAds = rankedAds.filter((ad) => ad.competitorBenchmarkScore != null);
  const avgBenchmark =
    scoredAds.length > 0
      ? scoredAds.reduce((sum, ad) => sum + (ad.competitorBenchmarkScore as number), 0) / scoredAds.length
      : null;
  const tierMix = { STRONG: 0, MODERATE: 0, WEAK: 0, LOW: 0 };
  for (const ad of rankedAds) {
    if (ad.benchmarkTier && ad.benchmarkTier in tierMix) {
      tierMix[ad.benchmarkTier as keyof typeof tierMix] += 1;
    }
  }
  const highConfidenceCount = rankedAds.filter((ad) => ad.benchmarkConfidence === 'HIGH').length;
  const notScoredCount = rankedAds.length - scoredAds.length;

  return (
    <section>
      <p>
        <Link href="/competitors">Back to competitors</Link>
      </p>

      <h1>{competitor.name}</h1>

      <div className="card">
        <h2>Overview</h2>
        <p><strong>Client:</strong> {competitor.client.name}</p>
        <p><strong>Industry:</strong> {competitor.industry.name}</p>
        <p><strong>Status:</strong> {competitor.status}</p>
        <p><strong>Discovery source:</strong> {competitor.discoverySource}</p>
        <p>
          <strong>Facebook page:</strong>{' '}
          {competitor.facebookPageUrl ? (
            <a href={competitor.facebookPageUrl} target="_blank" rel="noreferrer">
              {competitor.facebookPageUrl}
            </a>
          ) : (
            'Not set'
          )}
        </p>
        <p>
          <strong>Meta Page ID:</strong>{' '}
          {competitor.metaPageId ? <code>{competitor.metaPageId}</code> : 'Not set'}
        </p>
        <p><strong>Readiness:</strong> {metaReadiness.label}</p>
        <p><strong>Last scanned:</strong> {formatDate(competitor.lastScannedAt)}</p>
      </div>

      <div className="card">
        <h2>Meta configuration</h2>
        <p>{metaReadiness.detail}</p>
        {competitor.metaPageId && (
          <p>
            Ingestion command:{' '}
            <code>COMPETITOR_ID={competitor.id} npm run meta:ingest</code>
          </p>
        )}
        <CompetitorMetaConfigForm
          competitorId={competitor.id}
          facebookPageUrl={competitor.facebookPageUrl}
          metaPageId={competitor.metaPageId}
        />
      </div>

      <div className="card">
        <h2>Benchmark summary {hasActiveFilters ? '(filtered view)' : '(all ads)'}</h2>
        <p>
          Ads shown: {rankedAds.length}
          {hasActiveFilters && <> of {competitor._count.ads} total</>}
        </p>
        <p>
          Average benchmark score (scored):{' '}
          {avgBenchmark !== null ? `${avgBenchmark.toFixed(1)} / 10` : 'N/A'}
        </p>
        <p>
          Tier mix: Strong {tierMix.STRONG} · Moderate {tierMix.MODERATE} · Weak{' '}
          {tierMix.WEAK} · Low {tierMix.LOW}
        </p>
        <p>High-confidence ads (Vision): {highConfidenceCount}</p>
        <p>Not scored yet: {notScoredCount}</p>
        <p>Scan runs: {competitor._count.scanRuns}</p>
      </div>

      {pendingAdCount > 0 && (
        <div className="card">
          <h2>Pending Meta ads</h2>
          <p>
            <strong>{pendingAdCount}</strong> ad
            {pendingAdCount !== 1 ? 's' : ''} discovered via the Meta Ad Library
            API {pendingAdCount !== 1 ? 'are' : 'is'} awaiting review.
          </p>
          <p>
            <Link href={`/meta-review?competitorId=${competitor.id}`}>
              Review pending ads
            </Link>
          </p>
        </div>
      )}

      <div className="card">
        <h2>Filter &amp; sort</h2>
        <FilterGroup
          label="Tier"
          paramKey="tier"
          current={tier}
          buildHref={buildHref}
          options={[
            { value: 'STRONG', label: 'Strong' },
            { value: 'MODERATE', label: 'Moderate' },
            { value: 'WEAK', label: 'Weak' },
            { value: 'LOW', label: 'Low' },
          ]}
        />
        <FilterGroup
          label="Confidence"
          paramKey="confidence"
          current={conf}
          buildHref={buildHref}
          options={[
            { value: 'HIGH', label: 'High' },
            { value: 'MEDIUM', label: 'Medium' },
            { value: 'LOW', label: 'Low' },
          ]}
        />
        <FilterGroup
          label="Creative source"
          paramKey="source"
          current={source}
          buildHref={buildHref}
          options={[
            { value: 'ASSET', label: 'Asset' },
            { value: 'MANUAL', label: 'Manual' },
            { value: 'FALLBACK', label: 'Fallback' },
          ]}
        />
        <FilterGroup
          label="Format"
          paramKey="format"
          current={format}
          buildHref={buildHref}
          options={[
            { value: 'STATIC', label: 'Static' },
            { value: 'VIDEO', label: 'Video' },
          ]}
        />
        <FilterGroup
          label="Sort"
          paramKey="sort"
          current={sort}
          buildHref={buildHref}
          includeAll={false}
          options={[
            { value: 'benchmark', label: 'Benchmark' },
            { value: 'newest', label: 'Newest' },
            { value: 'longestRunning', label: 'Longest-running' },
          ]}
        />
        {hasActiveFilters && (
          <p style={{ marginTop: '8px' }}>
            <strong>Active filters:</strong> {activeFilterLabels.join(', ')}
            {' · '}
            <Link
              href={buildHref({ tier: undefined, confidence: undefined, source: undefined, format: undefined })}
            >
              Clear filters
            </Link>
          </p>
        )}
      </div>

      <div className="card">
        <h2>Competitor ads — ranked by benchmark</h2>
        {rankedAds.length === 0 ? (
          hasActiveFilters ? (
            <p>
              No ads match these filters.{' '}
              <Link
                href={buildHref({ tier: undefined, confidence: undefined, source: undefined, format: undefined })}
              >
                Clear filters
              </Link>{' '}
              to view all competitor ads.
            </p>
          ) : (
            <p>No ads found for this competitor yet.</p>
          )
        ) : (
          rankedAds.map((ad) => {
            const scored = ad.competitorBenchmarkScore != null;
            return (
              <div className="card" key={ad.id}>
                <p>
                  <strong>
                    {scored
                      ? `${(ad.competitorBenchmarkScore as number).toFixed(1)} / 10`
                      : 'Not scored yet'}
                  </strong>
                  {scored && <> · {tierLabel(ad.benchmarkTier)}</>}
                  {' · '}
                  <span className="badge">{confidenceLabel(ad.benchmarkConfidence)}</span>
                </p>
                <p>
                  <strong>Format:</strong> {ad.adFormat}
                  {' · '}
                  <strong>Creative:</strong> {creativeSourceLabel(ad.creativeSource)}
                  {' · '}
                  <strong>Evidence:</strong> {evidenceLabel(ad.evidenceSource)}
                </p>
                <p>
                  <strong>Headline:</strong>{' '}
                  {ad.headline ?? ad.metaAdId ?? 'No headline available'}
                </p>
                <p className="muted" style={{ fontSize: '12px' }}>
                  Internal QA score: {ad.score.toFixed(1)} / 10 (for comparison only)
                </p>
                <p>
                  <Link href={`/ads/${ad.id}`}>Open ad detail</Link>
                  {' | '}
                  <a href={ad.adLink} target="_blank" rel="noreferrer">
                    Open Facebook ad
                  </a>
                </p>
              </div>
            );
          })
        )}
      </div>

      <div className="card">
        <h2>Scan run history</h2>
        {scanRuns.length === 0 ? (
          <p>No scan runs recorded for this competitor.</p>
        ) : (
          scanRuns.map((run) => (
            <div className="card" key={run.id}>
              <p>
                <strong>{run.source}</strong> · {run.status}
              </p>
              <p><strong>Started:</strong> {formatDate(run.startedAt)}</p>
              {run.completedAt && (
                <p><strong>Completed:</strong> {formatDate(run.completedAt)}</p>
              )}
              <p>
                New: {run.newAdsFound} · Removed: {run.adsRemoved} · Unchanged: {run.adsUnchanged}
              </p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
