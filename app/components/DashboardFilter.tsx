'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

type Industry = {
  slug: string;
  name: string;
};

const SELECT_STYLE: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: '6px',
  border: '1px solid #dbe3f0',
  fontSize: '14px',
};

const LABEL_STYLE: React.CSSProperties = {
  fontWeight: 'bold',
  whiteSpace: 'nowrap',
};

export default function DashboardFilter({
  industries,
  currentIndustry,
  currentSearch,
  currentQualified,
  currentSource,
  currentFormat,
  currentScore,
}: {
  industries: Industry[];
  currentIndustry: string;
  currentSearch: string;
  currentQualified: string;
  currentSource: string;
  currentFormat: string;
  currentScore: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const updateParams = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      router.push(`/?${params.toString()}`);
    },
    [router, searchParams]
  );

  return (
    <div
      className="card"
      style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}
    >
      {/* Industry */}
      <label htmlFor="filter-industry" style={LABEL_STYLE}>Industry:</label>
      <select
        id="filter-industry"
        value={currentIndustry}
        onChange={(e) => updateParams('industry', e.target.value)}
        style={SELECT_STYLE}
      >
        <option value="">All industries</option>
        {industries.map((ind) => (
          <option key={ind.slug} value={ind.slug}>{ind.name}</option>
        ))}
      </select>

      {/* Qualified */}
      <label htmlFor="filter-qualified" style={LABEL_STYLE}>Qualified:</label>
      <select
        id="filter-qualified"
        value={currentQualified}
        onChange={(e) => updateParams('qualified', e.target.value)}
        style={SELECT_STYLE}
      >
        <option value="true">Qualified only</option>
        <option value="all">All</option>
        <option value="false">Not qualified</option>
      </select>

      {/* Source */}
      <label htmlFor="filter-source" style={LABEL_STYLE}>Source:</label>
      <select
        id="filter-source"
        value={currentSource}
        onChange={(e) => updateParams('source', e.target.value)}
        style={SELECT_STYLE}
      >
        <option value="">All sources</option>
        <option value="browser_collected">Browser collected</option>
      </select>

      {/* Format */}
      <label htmlFor="filter-format" style={LABEL_STYLE}>Format:</label>
      <select
        id="filter-format"
        value={currentFormat}
        onChange={(e) => updateParams('format', e.target.value)}
        style={SELECT_STYLE}
      >
        <option value="">All formats</option>
        <option value="STATIC">STATIC</option>
        <option value="VIDEO">VIDEO</option>
      </select>

      {/* Score */}
      <label htmlFor="filter-score" style={LABEL_STYLE}>Score:</label>
      <select
        id="filter-score"
        value={currentScore}
        onChange={(e) => updateParams('score', e.target.value)}
        style={SELECT_STYLE}
      >
        <option value="">All scores</option>
        <option value="high">High &ge; 7</option>
        <option value="mid">Mid 5 &ndash; 6.9</option>
        <option value="low">Low &lt; 5</option>
      </select>

      {/* Search */}
      <label htmlFor="filter-search" style={{ ...LABEL_STYLE, marginLeft: '4px' }}>Search:</label>
      <input
        id="filter-search"
        type="text"
        placeholder="Competitor, product, headline..."
        defaultValue={currentSearch}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            updateParams('q', (e.target as HTMLInputElement).value);
          }
        }}
        onBlur={(e) => {
          if (e.target.value !== currentSearch) {
            updateParams('q', e.target.value);
          }
        }}
        style={{
          ...SELECT_STYLE,
          flex: '1',
          minWidth: '160px',
        }}
      />
    </div>
  );
}
