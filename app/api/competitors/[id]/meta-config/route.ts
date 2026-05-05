import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import {
  findMetaPageIdConflict,
  updateCompetitorMetaConfig,
  type MetaConfigUpdate,
} from '@/lib/queries/competitors';

const FACEBOOK_URL_PATTERN = /^https:\/\/(www\.)?facebook\.com\//i;
const META_PAGE_ID_PATTERN = /^\d+$/;
const META_PAGE_ID_MAX_LENGTH = 20;

type MetaConfigBody = {
  facebookPageUrl?: unknown;
  metaPageId?: unknown;
};

function normaliseOptionalString(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string.`);
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function validateFacebookPageUrl(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!FACEBOOK_URL_PATTERN.test(value)) {
    throw new Error(
      `facebookPageUrl must start with https://www.facebook.com/ or https://facebook.com/. Received: ${value}`,
    );
  }
  return value;
}

function validateMetaPageId(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!META_PAGE_ID_PATTERN.test(value)) {
    throw new Error('metaPageId must contain digits only.');
  }
  if (value.length > META_PAGE_ID_MAX_LENGTH) {
    throw new Error(`metaPageId must be ${META_PAGE_ID_MAX_LENGTH} characters or fewer.`);
  }
  return value;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const body = (await request.json()) as MetaConfigBody;

    const facebookPageUrl = validateFacebookPageUrl(
      normaliseOptionalString(body.facebookPageUrl, 'facebookPageUrl'),
    );
    const metaPageId = validateMetaPageId(
      normaliseOptionalString(body.metaPageId, 'metaPageId'),
    );

    const data: MetaConfigUpdate = {};
    if (facebookPageUrl !== undefined) data.facebookPageUrl = facebookPageUrl;
    if (metaPageId !== undefined) data.metaPageId = metaPageId;

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: 'Provide facebookPageUrl or metaPageId to update.' },
        { status: 400 },
      );
    }

    if (data.metaPageId) {
      const conflict = await findMetaPageIdConflict(data.metaPageId, params.id);
      if (conflict) {
        return NextResponse.json(
          { error: `Meta Page ID is already assigned to competitor ${conflict.name}.` },
          { status: 400 },
        );
      }
    }

    const updatedCompetitor = await updateCompetitorMetaConfig(params.id, data);

    return NextResponse.json({ competitor: updatedCompetitor });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return NextResponse.json({ error: 'Competitor not found.' }, { status: 404 });
    }

    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : 'Unable to update competitor Meta configuration.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
