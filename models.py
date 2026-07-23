"""Pydantic models for the Meta ads search API."""

from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class AdsQuery(BaseModel):
    """Validated query parameters for an ads search request."""

    model_config = ConfigDict(str_strip_whitespace=True)

    industry: str = Field(..., min_length=2, description="Industry keyword to search for.")
    country: str = Field(
        default="GB",
        min_length=2,
        max_length=2,
        description="Two letter ISO country code.",
    )
    limit: int = Field(
        default=50,
        ge=1,
        le=100,
        description="Maximum number of ads to return (max 100).",
    )

    @field_validator("country")
    @classmethod
    def uppercase_country(cls, value: str) -> str:
        """Ensure the supplied country code is upper case."""

        return value.upper()


class NormalisedAd(BaseModel):
    """Normalised representation of a Meta ad."""

    model_config = ConfigDict(str_strip_whitespace=True)

    source: Literal["meta"] = "meta"
    advertiser: Optional[str] = None
    title: Optional[str] = None
    body: Optional[str] = None
    creative_url: Optional[str] = None
    first_seen: Optional[str] = None
    last_seen: Optional[str] = None
    status: Optional[Literal["active", "inactive"]] = None
    platforms: Optional[List[str]] = None
    snapshot_url: Optional[str] = None


class AdsResponse(BaseModel):
    """API response payload."""

    query: AdsQuery
    count: int
    results: List[NormalisedAd]
