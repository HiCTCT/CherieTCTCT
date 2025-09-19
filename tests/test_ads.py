"""Tests for the Meta ads FastAPI endpoint."""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest
import respx
from fastapi.testclient import TestClient


sys.path.append(str(Path(__file__).resolve().parents[1]))

from app import app
from meta_client import BASE_URL


@pytest.fixture()
def client() -> TestClient:
    """Return a test client for the FastAPI app."""

    with TestClient(app) as test_client:
        yield test_client


def test_get_ads_success(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    """Ensure a successful call returns normalised ads."""

    monkeypatch.setenv("META_ADLIB_TOKEN", "test-token")
    payload = {
        "data": [
            {
                "page_name": "Acme Corp",
                "ad_creative_link_titles": ["Big Sale"],
                "ad_creative_bodies": ["Buy now"],
                "ad_snapshot_url": "https://example.com/snapshot",
                "ad_delivery_start_time": "2024-05-01T00:00:00+0000",
                "ad_delivery_stop_time": None,
                "ad_creation_time": "2024-05-01T00:00:00+0000",
                "publisher_platforms": ["facebook"],
            }
        ],
        "paging": {},
    }

    with respx.mock(assert_all_called=True) as router:
        router.get(BASE_URL, params__contains={"search_terms": "finance"}).respond(200, json=payload)
        response = client.get("/ads", params={"industry": "finance"})

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    assert body["results"][0]["source"] == "meta"
    assert body["results"][0]["status"] == "active"
    assert body["results"][0]["advertiser"] == "Acme Corp"


def test_get_ads_invalid_params(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    """Invalid query params should trigger a 422 error."""

    monkeypatch.setenv("META_ADLIB_TOKEN", "test-token")
    response = client.get("/ads", params={"industry": "a"})
    assert response.status_code == 422

    response = client.get("/ads", params={"industry": "finance", "country": "GBR"})
    assert response.status_code == 422


def test_get_ads_missing_token(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    """If the env var is missing, return an informative 500."""

    monkeypatch.delenv("META_ADLIB_TOKEN", raising=False)
    response = client.get("/ads", params={"industry": "finance"})
    assert response.status_code == 500
    assert response.json() == {"error": "META_ADLIB_TOKEN not set"}


def test_get_ads_upstream_error(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    """A Meta API error should surface as a 502."""

    monkeypatch.setenv("META_ADLIB_TOKEN", "test-token")
    error_payload = {"error": {"code": 190, "message": "Token expired"}}
    with respx.mock(assert_all_called=True) as router:
        router.get(BASE_URL, params__contains={"search_terms": "finance"}).respond(400, json=error_payload)
        response = client.get("/ads", params={"industry": "finance"})

    assert response.status_code == 502
    assert response.json() == {"error": {"code": 190, "message": "Token expired"}}


def test_get_ads_timeout(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    """Timeouts should map to a 504 response."""

    monkeypatch.setenv("META_ADLIB_TOKEN", "test-token")
    with respx.mock(assert_all_called=True) as router:
        router.get(BASE_URL, params__contains={"search_terms": "finance"}).mock(
            side_effect=httpx.ReadTimeout("Timeout")
        )
        response = client.get("/ads", params={"industry": "finance"})

    assert response.status_code == 504
    assert response.json() == {"error": "Upstream timeout"}


def test_get_ads_pagination(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    """Pagination should continue until the requested limit is met."""

    monkeypatch.setenv("META_ADLIB_TOKEN", "test-token")
    next_url = f"{BASE_URL}?after=token"
    first_page = {
        "data": [
            {
                "page_name": "Page A",
                "ad_creative_link_titles": ["Title A"],
                "ad_creative_bodies": ["Body A"],
                "ad_snapshot_url": "https://example.com/a",
                "ad_delivery_start_time": "2024-05-01T00:00:00+0000",
                "ad_delivery_stop_time": "2024-05-04T00:00:00+0000",
                "ad_creation_time": "2024-05-01T00:00:00+0000",
            },
            {
                "page_name": "Page B",
                "ad_creative_link_titles": ["Title B"],
                "ad_creative_bodies": ["Body B"],
                "ad_snapshot_url": "https://example.com/b",
                "ad_delivery_start_time": "2024-05-02T00:00:00+0000",
                "ad_delivery_stop_time": None,
                "ad_creation_time": "2024-05-02T00:00:00+0000",
            },
        ],
        "paging": {"next": next_url},
    }
    second_page = {
        "data": [
            {
                "page_name": "Page C",
                "ad_creative_link_titles": ["Title C"],
                "ad_creative_bodies": ["Body C"],
                "ad_snapshot_url": "https://example.com/c",
                "ad_delivery_start_time": "2024-05-03T00:00:00+0000",
                "ad_delivery_stop_time": "2024-05-05T00:00:00+0000",
                "ad_creation_time": "2024-05-03T00:00:00+0000",
            },
            {
                "page_name": "Page D",
                "ad_creative_link_titles": ["Title D"],
                "ad_creative_bodies": ["Body D"],
                "ad_snapshot_url": "https://example.com/d",
                "ad_delivery_start_time": "2024-05-04T00:00:00+0000",
                "ad_delivery_stop_time": None,
                "ad_creation_time": "2024-05-04T00:00:00+0000",
            },
        ],
        "paging": {},
    }

    with respx.mock(assert_all_called=True) as router:
        router.get(BASE_URL, params__contains={"search_terms": "tech"}).respond(200, json=first_page)
        router.get(next_url).respond(200, json=second_page)
        response = client.get("/ads", params={"industry": "tech", "limit": 3})

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 3
    titles = [item["title"] for item in body["results"]]
    assert titles == ["Title C", "Title A", "Title B"]
