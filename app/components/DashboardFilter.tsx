'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

type Industry = {
  slug: string;
  name: string;
};

export default function DashboardFilter({
  industries,
  currentIndustry,
  currentSearch,
}: {
  industries: Industry[];
  currentIndustry: string;
  currentSearch: string;
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
    <div className="card" style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
      <label htmlFor="industry-filter" style={{ fontWeight: 'bold' }}>
        Industry:
      </label>
      <select
        id="industry-filter"
        value={currentIndustry}
        onChange={(e) => updateParams('industry', e.target.value)}
        style={{
          padding: '6px 10px',
          borderRadius: '6px',
          border: '1px solid #dbe3f0',
          fontSize: '14px',
        }}
      >
        <option value="">All industries</option>
        {industries.map((ind) => (
          <option key={ind.slug} value={ind.slug}>
            {ind.name}
          </option>
        ))}
      </select>

      <label htmlFor="search-filter" style={{ fontWeight: 'bold', marginLeft: '8px' }}>
        Search:
      </label>
      <input
        id="search-filter"
        type="text"
        placeholder="Competitor, product, headline\u2026"
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
          padding: '6px 10px',
          borderRadius: '6px',
          border: '1px solid #dbe3f0',
          fontSize: '14px',
          flex: '1',
          minWidth: '180px',
        }}
      />
    </div>
  );
}
