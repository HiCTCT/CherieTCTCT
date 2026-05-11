/**
 * Phase 6 Step 4 — Import Readiness Check
 *
 * Read-only CLI. No DB writes. No Meta API calls. No token required.
 *
 * Run after a live import to verify what was created and what still needs
 * attention before running meta:batch.
 *
 * Usage:
 *   npm run import:check
 *
 * Optional filters:
 *   CHECK_CLIENT=<name>   Scope report to a single client (exact match)
 *   CHECK_INDUSTRY=<name> Scope report to an industry
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['error'] });

// ── Helpers ────────────────────────────────────────────────────────────────────

function hr(char = '─', width = 70): string {
  return char.repeat(width);
}

function section(title: string): void {
  console.log('');
  console.log(hr());
  console.log(`  ${title}`);
  console.log(hr());
}

function indent(s: string, n = 2): string {
  return ' '.repeat(n) + s;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

// ── Normalisation (mirrors import script — for duplicate detection only) ──────

// Mirrors normalizeCompetitorName in scripts/import-client-competitors.ts exactly.
// Keep these two functions in sync whenever the import script's normalisation changes.
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(pte\.?\s*ltd\.?|sdn\.?\s*bhd\.?|ltd\.?|inc\.?|corp\.?|llc\.?|co\.?)\b/g, '')
    .replace(/\b(singapore|sg|asia|global|international|intl)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const filterClient = process.env.CHECK_CLIENT?.trim();
  const filterIndustry = process.env.CHECK_INDUSTRY?.trim();

  // ── Fetch all data in one pass ──────────────────────────────────────────────

  const clientWhere = {
    ...(filterClient ? { name: filterClient } : {}),
    ...(filterIndustry ? { industry: { name: filterIndustry } } : {}),
  };

  const clients = await prisma.client.findMany({
    where: clientWhere,
    include: {
      industry: true,
      competitors: true,
    },
    orderBy: { name: 'asc' },
  });

  if (clients.length === 0) {
    const filterMsg = filterClient
      ? `client "${filterClient}"`
      : filterIndustry
        ? `industry "${filterIndustry}"`
        : 'any client';
    console.log(`\nNo clients found matching ${filterMsg}. Run import:clients first.`);
    await prisma.$disconnect();
    return;
  }

  const allCompetitors = clients.flatMap((c) =>
    c.competitors.map((comp) => ({ ...comp, clientName: c.name, industryName: c.industry.name })),
  );

  // ── Segment competitors ─────────────────────────────────────────────────────

  const manual = allCompetitors.filter((c) => c.discoverySource === 'manual');
  const withMetaId = allCompetitors.filter((c) => !!c.metaPageId && c.metaPageId !== '');
  const missingMetaId = allCompetitors.filter((c) => !c.metaPageId || c.metaPageId === '');
  const withFbUrl = allCompetitors.filter((c) => !!c.facebookPageUrl);
  const fbNoMeta = allCompetitors.filter((c) => !!c.facebookPageUrl && (!c.metaPageId || c.metaPageId === ''));
  const metaNoFb = allCompetitors.filter((c) => !!c.metaPageId && c.metaPageId !== '' && !c.facebookPageUrl);
  // readyToScan mirrors getMetaReadyCompetitors() in lib/queries/competitors.ts:
  // the only gate is a non-null, non-empty metaPageId. Status is not a filter.
  const readyToScan = withMetaId;
  const neverScanned = readyToScan.filter((c) => !c.lastScannedAt);
  const scanned = readyToScan.filter((c) => !!c.lastScannedAt);
  // Status breakdown among scan-eligible competitors (informational only).
  const approvedAndReady = readyToScan.filter((c) => c.status === 'APPROVED');
  const nonApprovedAndReady = readyToScan.filter((c) => c.status !== 'APPROVED');

  // ── Possible duplicates (same normalised name, different exact name, same client) ──

  type DupEntry = { clientName: string; name: string; normalized: string; metaPageId: string | null };
  const dupCandidates: Array<{ a: DupEntry; b: DupEntry }> = [];

  const byClient = new Map<string, DupEntry[]>();
  for (const c of allCompetitors) {
    const key = c.clientId;
    if (!byClient.has(key)) byClient.set(key, []);
    byClient.get(key)!.push({
      clientName: c.clientName,
      name: c.name,
      normalized: normalizeName(c.name),
      metaPageId: c.metaPageId,
    });
  }

  const seenDupPairs = new Set<string>();
  for (const entries of byClient.values()) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]!;
        const b = entries[j]!;
        if (
          a.normalized === b.normalized &&
          a.normalized.length > 0 &&
          a.name !== b.name
        ) {
          const pairKey = `${a.clientName}::${[a.name, b.name].sort().join('||')}`;
          if (!seenDupPairs.has(pairKey)) {
            seenDupPairs.add(pairKey);
            dupCandidates.push({ a, b });
          }
        }
      }
    }
  }

  // ── Same Meta Page ID, same client, different name ─────────────────────────

  type MetaDupEntry = { clientName: string; name: string; metaPageId: string };
  const metaDups: Array<{ metaPageId: string; entries: MetaDupEntry[] }> = [];

  const metaByClient = new Map<string, Map<string, MetaDupEntry[]>>();
  for (const c of allCompetitors) {
    if (!c.metaPageId) continue;
    if (!metaByClient.has(c.clientId)) metaByClient.set(c.clientId, new Map());
    const byId = metaByClient.get(c.clientId)!;
    if (!byId.has(c.metaPageId)) byId.set(c.metaPageId, []);
    byId.get(c.metaPageId)!.push({ clientName: c.clientName, name: c.name, metaPageId: c.metaPageId });
  }

  for (const byId of metaByClient.values()) {
    for (const [metaPageId, entries] of byId.entries()) {
      if (entries.length > 1) {
        metaDups.push({ metaPageId, entries });
      }
    }
  }

  // ── Print report ────────────────────────────────────────────────────────────

  const scopeLabel = filterClient
    ? ` — client: ${filterClient}`
    : filterIndustry
      ? ` — industry: ${filterIndustry}`
      : '';

  console.log('');
  console.log(hr('═'));
  console.log(`  Import Readiness Check${scopeLabel}`);
  console.log(`  Run at: ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`);
  console.log(hr('═'));

  // ── Summary counts ──────────────────────────────────────────────────────────

  section('Summary');
  console.log(indent(`Clients:                         ${clients.length}`));
  console.log(indent(`Competitors (total):             ${allCompetitors.length}`));
  console.log(indent(`  Manually imported:             ${manual.length}`));
  console.log(indent(`  With Meta Page ID:             ${withMetaId.length}`));
  console.log(indent(`  Missing Meta Page ID:          ${missingMetaId.length}`));
  console.log(indent(`  With Facebook URL:             ${withFbUrl.length}`));
  console.log(indent(`  Facebook URL, no Meta ID:      ${fbNoMeta.length}`));
  console.log(indent(`  Meta ID, no Facebook URL:      ${metaNoFb.length}`));
  console.log(indent(`Ready for Meta scan (has Meta Page ID): ${readyToScan.length}`));
  console.log(indent(`  Never scanned:                 ${neverScanned.length}`));
  console.log(indent(`  Previously scanned:            ${scanned.length}`));
  console.log(indent(`  Status APPROVED:               ${approvedAndReady.length}`));
  console.log(indent(`  Other status:                  ${nonApprovedAndReady.length}`));
  console.log(indent(`Possible duplicates (name):      ${dupCandidates.length}`));
  console.log(indent(`Possible duplicates (Meta ID):   ${metaDups.length}`));

  // ── Clients ─────────────────────────────────────────────────────────────────

  section('Clients');
  for (const client of clients) {
    const total = client.competitors.length;
    const ready = client.competitors.filter((c) => !!c.metaPageId && c.metaPageId !== '').length;
    const missing = client.competitors.filter((c) => !c.metaPageId || c.metaPageId === '').length;
    console.log(indent(`${client.name}  [${client.industry.name}]`));
    console.log(indent(`  Competitors: ${total}  |  Ready to scan: ${ready}  |  Missing Meta ID: ${missing}`));
    if (client.whatTheySell) {
      console.log(indent(`  Sells: ${client.whatTheySell}`));
    }
  }

  // ── Ready to scan ───────────────────────────────────────────────────────────

  section(`Competitors ready for Meta scan — has Meta Page ID (${readyToScan.length})`);
  if (readyToScan.length === 0) {
    console.log(indent('None. Add Meta Page IDs to competitors to enable scanning.'));
  } else {
    const colW = 36;
    console.log(indent(`${pad('Name', colW)}  ${pad('Client', 24)}  Meta Page ID          Last Scanned`));
    console.log(indent(hr('-', 100)));
    for (const c of readyToScan.sort((a, b) => a.name.localeCompare(b.name))) {
      const lastScan = c.lastScannedAt
        ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(c.lastScannedAt)
        : 'Never';
      console.log(indent(`${pad(c.name, colW)}  ${pad(c.clientName, 24)}  ${pad(c.metaPageId!, 20)}  ${lastScan}`));
    }
  }

  // ── Missing Meta Page ID ────────────────────────────────────────────────────

  section(`Competitors missing Meta Page ID (${missingMetaId.length})`);
  if (missingMetaId.length === 0) {
    console.log(indent('None. All competitors have a Meta Page ID.'));
  } else {
    const colW = 36;
    console.log(indent(`${pad('Name', colW)}  ${pad('Client', 24)}  Facebook URL`));
    console.log(indent(hr('-', 100)));
    for (const c of missingMetaId.sort((a, b) => a.name.localeCompare(b.name))) {
      const fb = c.facebookPageUrl ?? '—';
      console.log(indent(`${pad(c.name, colW)}  ${pad(c.clientName, 24)}  ${fb}`));
    }
  }

  // ── Facebook URL but no Meta ID ─────────────────────────────────────────────

  section(`Competitors with Facebook URL but missing Meta Page ID (${fbNoMeta.length})`);
  if (fbNoMeta.length === 0) {
    console.log(indent('None.'));
  } else {
    console.log(indent('These have a Facebook Page URL. Visit the Ad Library to find their Meta Page ID.'));
    console.log('');
    for (const c of fbNoMeta.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(indent(`${c.name}  [${c.clientName}]`));
      console.log(indent(`  Facebook: ${c.facebookPageUrl}`));
      console.log(indent(`  Ad Library search: https://www.facebook.com/ads/library/?q=${encodeURIComponent(c.name)}&search_type=page`));
    }
  }

  // ── Meta ID but no Facebook URL ─────────────────────────────────────────────

  section(`Competitors with Meta Page ID but missing Facebook URL (${metaNoFb.length})`);
  if (metaNoFb.length === 0) {
    console.log(indent('None.'));
  } else {
    console.log(indent('These can be scanned but have no Facebook URL on record. Add the URL when convenient.'));
    console.log('');
    const colW = 36;
    console.log(indent(`${pad('Name', colW)}  ${pad('Client', 24)}  Meta Page ID`));
    console.log(indent(hr('-', 80)));
    for (const c of metaNoFb.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(indent(`${pad(c.name, colW)}  ${pad(c.clientName, 24)}  ${c.metaPageId}`));
    }
  }

  // ── Possible duplicates — normalised name ───────────────────────────────────

  section(`Possible duplicate names to review (${dupCandidates.length})`);
  if (dupCandidates.length === 0) {
    console.log(indent('None found.'));
  } else {
    console.log(indent('These pairs share the same normalised name under the same client.'));
    console.log(indent('Review manually to confirm they are different advertisers.'));
    console.log('');
    for (const { a, b } of dupCandidates) {
      console.log(indent(`Client: ${a.clientName}`));
      console.log(indent(`  "${a.name}"  (Meta ID: ${a.metaPageId ?? '—'})`));
      console.log(indent(`  "${b.name}"  (Meta ID: ${b.metaPageId ?? '—'})`));
      console.log(indent(`  Normalised to: "${a.normalized}"`));
      console.log('');
    }
  }

  // ── Possible duplicates — same Meta Page ID ─────────────────────────────────

  section(`Possible duplicate Meta Page IDs to review (${metaDups.length})`);
  if (metaDups.length === 0) {
    console.log(indent('None found.'));
  } else {
    console.log(indent('Multiple competitors share the same Meta Page ID under the same client.'));
    console.log(indent('They likely represent the same advertiser. Keep one and delete the other in the app.'));
    console.log('');
    for (const { metaPageId, entries } of metaDups) {
      console.log(indent(`Meta Page ID: ${metaPageId}  [Client: ${entries[0]!.clientName}]`));
      for (const e of entries) {
        console.log(indent(`  "${e.name}"`));
      }
      console.log('');
    }
  }

  // ── Manually imported competitors ────────────────────────────────────────────

  section(`Manually imported competitors (${manual.length})`);
  if (manual.length === 0) {
    console.log(indent('None imported via CSV yet.'));
  } else {
    const colW = 36;
    console.log(indent(`${pad('Name', colW)}  ${pad('Client', 24)}  Status      Meta ID`));
    console.log(indent(hr('-', 100)));
    for (const c of manual.sort((a, b) => a.name.localeCompare(b.name))) {
      const metaId = c.metaPageId ?? '—';
      console.log(indent(`${pad(c.name, colW)}  ${pad(c.clientName, 24)}  ${pad(c.status, 10)}  ${metaId}`));
    }
  }

  // ── Recommended next steps ───────────────────────────────────────────────────

  section('Recommended next steps');

  const steps: string[] = [];

  if (missingMetaId.length > 0) {
    steps.push(
      `${missingMetaId.length} competitor(s) are missing a Meta Page ID. ` +
        `Open /competitors/<id> in the app and save the Meta Page ID in the Meta configuration card.`,
    );
  }

  if (fbNoMeta.length > 0) {
    steps.push(
      `${fbNoMeta.length} competitor(s) have a Facebook URL but no Meta Page ID. ` +
        `Visit the Ad Library links above to find the correct Meta Page ID.`,
    );
  }

  if (dupCandidates.length > 0 || metaDups.length > 0) {
    steps.push(
      `${dupCandidates.length + metaDups.length} suspected duplicate(s) found. ` +
        `Review the pairs above and remove any that are the same advertiser.`,
    );
  }

  if (neverScanned.length > 0) {
    steps.push(
      `${neverScanned.length} competitor(s) have a Meta Page ID and have never been scanned. ` +
        `Run: META_ADLIB_TOKEN=<token> META_DRY_RUN=true npm run meta:batch`,
    );
  }

  if (scanned.length > 0) {
    steps.push(`${scanned.length} competitor(s) have been scanned before and are ready to re-scan.`);
  }

  if (missingMetaId.length === 0 && dupCandidates.length === 0 && metaDups.length === 0) {
    steps.push('All competitors have a Meta Page ID and no duplicates were detected. You are ready to run meta:batch.');
  }

  if (steps.length === 0) {
    console.log(indent('Nothing to action.'));
  } else {
    steps.forEach((s, i) => console.log(indent(`${i + 1}. ${s}`)));
  }

  console.log('');
  console.log(hr('═'));
  console.log('');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('check-import-readiness failed:', err);
  prisma.$disconnect();
  process.exit(1);
});
