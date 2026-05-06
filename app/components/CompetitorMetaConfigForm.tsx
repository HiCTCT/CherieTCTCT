'use client';

import { useState } from 'react';

type CompetitorMetaConfigFormProps = {
  competitorId: string;
  facebookPageUrl: string | null;
  metaPageId: string | null;
};

type MetaConfigResponse = {
  error?: string;
};

async function parseJsonSafely(response: Response): Promise<MetaConfigResponse> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text) as MetaConfigResponse;
  } catch {
    return {};
  }
}

export default function CompetitorMetaConfigForm({
  competitorId,
  facebookPageUrl,
  metaPageId,
}: CompetitorMetaConfigFormProps) {
  const [facebookUrlValue, setFacebookUrlValue] = useState(facebookPageUrl ?? '');
  const [metaPageIdValue, setMetaPageIdValue] = useState(metaPageId ?? '');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/competitors/${competitorId}/meta-config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facebookPageUrl: facebookUrlValue,
          metaPageId: metaPageIdValue,
        }),
      });

      const payload = await parseJsonSafely(response);

      if (!response.ok) {
        throw new Error(payload.error ?? `Request failed (${response.status}).`);
      }

      setStatusMessage('Meta configuration saved. Refreshing page...');
      window.location.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to save Meta configuration.';
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div style={{ marginBottom: '12px' }}>
        <label htmlFor="facebookPageUrl">
          <strong>Facebook page URL</strong>
        </label>
        <div style={{ marginTop: '8px' }}>
          <input
            id="facebookPageUrl"
            name="facebookPageUrl"
            type="url"
            value={facebookUrlValue}
            onChange={(event) => setFacebookUrlValue(event.target.value)}
            placeholder="https://www.facebook.com/brand"
            style={{ minWidth: '320px', padding: '8px' }}
          />
        </div>
      </div>

      <div style={{ marginBottom: '12px' }}>
        <label htmlFor="metaPageId">
          <strong>Meta Page ID</strong>
        </label>
        <div style={{ marginTop: '8px' }}>
          <input
            id="metaPageId"
            name="metaPageId"
            type="text"
            inputMode="numeric"
            value={metaPageIdValue}
            onChange={(event) => setMetaPageIdValue(event.target.value)}
            placeholder="100001234567890"
            style={{ minWidth: '320px', padding: '8px' }}
          />
        </div>
      </div>

      <button type="submit" disabled={isSaving} style={{ padding: '8px 12px' }}>
        {isSaving ? 'Saving...' : 'Save Meta configuration'}
      </button>

      {statusMessage && <p style={{ color: 'green' }}>{statusMessage}</p>}
      {errorMessage && <p style={{ color: 'crimson' }}>{errorMessage}</p>}
    </form>
  );
}
