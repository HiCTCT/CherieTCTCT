"""Client helpers for talking to the Meta Ad Library."""

from __future__ import annotations

import asyncio
import logging
import random
import time
from collections import deque
from typing import Any, Deque, Dict, Iterable, List, Optional

import httpx

from models import AdsQuery, NormalisedAd

LOGGER = logging.getLogger(__name__)

BASE_URL = "https://graph.facebook.com/v23.0/ads_archive"
HTTP_TIMEOUT = 30.0
RATE_LIMIT_PER_SECOND = 5
RATE_LIMIT_WINDOW = 1.0
RATE_LIMIT_JITTER_RANGE = (0.05, 0.15)
PAGE_DELAY_SECONDS = 0.15

_request_lock = asyncio.Lock()
_request_timestamps: Deque[float] = deque()


class MetaAPIError(Exception):
    """Raised when the Meta API returns an error response."""

    def __init__(self, status_code: int, code: Optional[int], message: str) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        super().__init__(message)


class MetaTimeoutError(Exception):
    """Raised when the Meta API request times out."""


async def _wait_for_rate_limit_slot() -> None:
    """Ensure we do not exceed the configured rate limit."""

    while True:
        async with _request_lock:
            now = time.monotonic()
            while _request_timestamps and now - _request_timestamps[0] >= RATE_LIMIT_WINDOW:
                _request_timestamps.popleft()
            if len(_request_timestamps) < RATE_LIMIT_PER_SECOND:
                _request_timestamps.append(now)
                return
            wait_time = RATE_LIMIT_WINDOW - (now - _request_timestamps[0])
        jitter = random.uniform(*RATE_LIMIT_JITTER_RANGE)
        await asyncio.sleep(max(wait_time, 0.0) + jitter)


def _first_or_none(values: Any) -> Optional[str]:
    """Return the first value from a list-like object, or the value itself."""

    if isinstance(values, list):
        return values[0] if values else None
    if isinstance(values, tuple):
        return values[0] if values else None
    if isinstance(values, str):
        return values
    return None


def _normalise_record(record: Dict[str, Any]) -> NormalisedAd:
    """Convert a raw Meta record into our normalised schema."""

    advertiser = record.get("page_name")
    title = _first_or_none(record.get("ad_creative_link_titles"))
    body = _first_or_none(record.get("ad_creative_bodies"))
    snapshot_url = record.get("ad_snapshot_url")
    start_time = record.get("ad_delivery_start_time")
    stop_time = record.get("ad_delivery_stop_time") or None
    creation_time = record.get("ad_creation_time")
    last_seen = stop_time or creation_time
    status = "inactive" if stop_time else "active"
    platforms = record.get("publisher_platforms")
    if platforms is not None and not isinstance(platforms, list):
        platforms = [str(platforms)]

    return NormalisedAd(
        advertiser=advertiser,
        title=title,
        body=body,
        creative_url=snapshot_url,
        first_seen=start_time,
        last_seen=last_seen,
        status=status,
        platforms=platforms,
        snapshot_url=snapshot_url,
    )


def _sort_ads(ads: Iterable[NormalisedAd]) -> List[NormalisedAd]:
    """Return ads sorted by last seen then first seen, both descending."""

    return sorted(
        ads,
        key=lambda ad: ((ad.last_seen or ""), (ad.first_seen or "")),
        reverse=True,
    )


async def fetch_ads(query: AdsQuery, token: str) -> List[NormalisedAd]:
    """Fetch and normalise ads from the Meta Ad Library."""

    params = {
        "search_terms": query.industry,
        "ad_active_status": "ALL",
        "ad_reached_countries": query.country,
        "fields": (
            "ad_creation_time,ad_delivery_start_time,ad_delivery_stop_time,"
            "ad_snapshot_url,page_id,page_name,ad_creative_bodies,"
            "ad_creative_link_titles,ad_creative_link_descriptions,publisher_platforms"
        ),
        "limit": query.limit,
        "access_token": token,
    }

    raw_records: List[Dict[str, Any]] = []
    next_url: Optional[str] = None
    page_count = 0
    start_time = time.perf_counter()

    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            while True:
                await _wait_for_rate_limit_slot()
                if next_url:
                    response = await client.get(next_url)
                else:
                    response = await client.get(BASE_URL, params=params)
                page_count += 1

                if response.status_code != httpx.codes.OK:
                    try:
                        payload = response.json()
                    except ValueError:  # pragma: no cover
                        payload = {"error": {"message": response.text}}
                    error = payload.get("error", {})
                    raise MetaAPIError(
                        status_code=response.status_code,
                        code=error.get("code"),
                        message=error.get("message", "Meta API error"),
                    )

                payload = response.json()
                data = payload.get("data", [])
                raw_records.extend(data)
                if len(raw_records) >= query.limit:
                    break
                paging = payload.get("paging", {})
                next_url = paging.get("next")
                if not next_url:
                    break
                await asyncio.sleep(PAGE_DELAY_SECONDS)
    except (
        httpx.ConnectTimeout,
        httpx.ReadTimeout,
        httpx.WriteTimeout,
        httpx.PoolTimeout,
        httpx.TimeoutException,
    ) as exc:
        raise MetaTimeoutError(str(exc)) from exc
    finally:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        LOGGER.info(
            "Meta request industry=%s country=%s pages=%s duration_ms=%s",
            query.industry,
            query.country,
            page_count,
            duration_ms,
        )

    if raw_records:
        raw_records = raw_records[: query.limit]

    normalised = [_normalise_record(record) for record in raw_records]
    return _sort_ads(normalised)
