"""FastAPI application exposing the Meta ads search endpoint."""

from __future__ import annotations

import logging
import os
from typing import Annotated

from fastapi import Depends, FastAPI, Query, status
from fastapi.responses import JSONResponse

from meta_client import MetaAPIError, MetaTimeoutError, fetch_ads
from models import AdsQuery, AdsResponse

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="Meta Ads Search API")


async def _query_dependency(
    industry: Annotated[
        str,
        Query(..., min_length=2, description="Industry keyword to search for."),
    ],
    country: Annotated[
        str,
        Query(min_length=2, max_length=2, description="Two letter ISO country code (default GB)."),
    ] = "GB",
    limit: Annotated[
        int,
        Query(ge=1, le=100, description="Maximum number of ads to return (max 100)."),
    ] = 50,
) -> AdsQuery:
    """Build the validated query model for downstream use."""

    return AdsQuery(industry=industry, country=country, limit=limit)


@app.get("/ads", response_model=AdsResponse)
async def get_ads(query: AdsQuery = Depends(_query_dependency)) -> AdsResponse:
    """Search the Meta Ad Library and return normalised ads."""

    token = os.getenv("META_ADLIB_TOKEN")
    if not token:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "META_ADLIB_TOKEN not set"},
        )

    try:
        ads = await fetch_ads(query, token)
    except MetaTimeoutError:
        return JSONResponse(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            content={"error": "Upstream timeout"},
        )
    except MetaAPIError as exc:
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"error": {"code": exc.code, "message": exc.message}},
        )

    return AdsResponse(query=query, count=len(ads), results=ads)
