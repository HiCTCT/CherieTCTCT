import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Read-only server for captured creative evidence (Phase G).
 *
 * Serves image files ONLY from data/creative-assets, with hard guards:
 *   - rejects path traversal and any path resolving outside data/creative-assets
 *   - rejects absolute paths outside the asset root
 *   - only serves .png / .jpg / .jpeg / .webp
 *   - 404 for missing files
 *
 * It never writes, never lists directories, and never touches the DB. The DB
 * stores the path; the binary stays local and uncommitted.
 *
 * Usage: GET /api/captured-asset?path=data/creative-assets/<competitor>/<adId>/image-01.png
 */

const ASSET_ROOT = path.resolve('data', 'creative-assets');

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rel = req.nextUrl.searchParams.get('path');
  if (!rel) {
    return new NextResponse('Missing path parameter.', { status: 400 });
  }

  // Resolve against the project root, then confirm it stays within the asset root.
  // path.resolve collapses any "../" and makes absolute inputs absolute, so an
  // out-of-root or traversal path simply fails the prefix check below.
  const resolved = path.resolve(process.cwd(), rel);
  if (resolved !== ASSET_ROOT && !resolved.startsWith(ASSET_ROOT + path.sep)) {
    return new NextResponse('Forbidden.', { status: 403 });
  }

  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    return new NextResponse('Unsupported file type.', { status: 415 });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return new NextResponse('Not found.', { status: 404 });
  }
  if (!stat.isFile()) {
    return new NextResponse('Not found.', { status: 404 });
  }

  const data = fs.readFileSync(resolved);
  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      'content-type': mime,
      'cache-control': 'private, max-age=300',
    },
  });
}
