from __future__ import annotations

from pydantic import BaseModel


class AccountSummary(BaseModel):
    id: str
    name: str | None = None


class CapabilitySummary(BaseModel):
    content_publish: bool
    messages: bool
    missing_permissions: list[str]


class MetaStatusResponse(BaseModel):
    configured: bool
    page: AccountSummary | None
    instagram: AccountSummary | None
    capabilities: CapabilitySummary

