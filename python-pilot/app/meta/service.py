from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet
from sqlalchemy import delete, or_, select, update
from sqlalchemy.orm import Session

from app.config import Settings
from app.storage.models import OAuthState, PlatformAccount, PlatformCredential

REQUIRED_PERMISSIONS = frozenset(
    {
        "business_management",
        "instagram_basic",
        "instagram_content_publish",
        "instagram_manage_messages",
        "pages_read_engagement",
        "pages_show_list",
    }
)


class MetaIntegrationError(Exception):
    """Safe internal error category; never relay provider responses to clients."""


@dataclass(frozen=True)
class DiscoveredAssets:
    page_id: str | None
    page_name: str | None
    instagram_id: str | None
    instagram_username: str | None
    granted_permissions: set[str]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _hash_state(state: str) -> str:
    return hashlib.sha256(state.encode("utf-8")).hexdigest()


def build_authorization_url(settings: Settings, session: Session) -> str:
    state = secrets.token_urlsafe(32)
    now = utcnow()
    session.execute(
        delete(OAuthState).where(or_(OAuthState.expires_at <= now, OAuthState.used_at.is_not(None)))
    )
    session.add(
        OAuthState(
            state_hash=_hash_state(state),
            created_at=now,
            expires_at=now + timedelta(seconds=settings.oauth_state_ttl_seconds),
        )
    )
    session.commit()
    query = urlencode(
        {
            "client_id": settings.meta_app_id,
            "redirect_uri": str(settings.meta_redirect_uri),
            "config_id": settings.meta_config_id,
            "response_type": "code",
            "override_default_response_type": "true",
            "state": state,
        }
    )
    return f"https://www.facebook.com/{settings.meta_graph_version}/dialog/oauth?{query}"


def consume_state(session: Session, state: str) -> bool:
    """One-time, expiry-aware atomic state consumption."""
    result = session.execute(
        update(OAuthState)
        .where(
            OAuthState.state_hash == _hash_state(state),
            OAuthState.used_at.is_(None),
            OAuthState.expires_at > utcnow(),
        )
        .values(used_at=utcnow())
    )
    session.commit()
    return result.rowcount == 1


class MetaClient:
    def __init__(self, settings: Settings, session: Session) -> None:
        self.settings = settings
        self.session = session
        self.fernet: Fernet = settings.fernet()
        self.graph_base = f"https://graph.facebook.com/{settings.meta_graph_version}"

    async def exchange_code(self, code: str) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=False) as client:
                response = await client.get(
                    f"{self.graph_base}/oauth/access_token",
                    params={
                        "client_id": self.settings.meta_app_id,
                        "client_secret": self.settings.meta_app_secret.get_secret_value(),
                        # Meta's manual authorization-code flow requires an exact
                        # match with the URI supplied to the authorization dialog.
                        "redirect_uri": str(self.settings.meta_redirect_uri),
                        "code": code,
                    },
                )
                response.raise_for_status()
                data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise MetaIntegrationError("Meta code exchange failed") from exc
        if not isinstance(data.get("access_token"), str) or not data["access_token"]:
            raise MetaIntegrationError("Meta response did not provide an access token")
        return data

    async def discover_assets(self, access_token: str) -> DiscoveredAssets:
        """Discover only Page assets explicitly granted to the system-user token.

        The normal user-token ``/me/accounts`` tutorial is intentionally not
        used. Login for Business system-user tokens are asset-limited, so target
        Page IDs come from Debug Token's granular grants and are queried one at
        a time with the exchanged token.
        """
        permissions, page_ids = await self._debug_token(access_token)
        if not page_ids:
            return DiscoveredAssets(None, None, None, None, permissions)

        selected: tuple[str, str | None, str | None] | None = None
        for page_id in sorted(page_ids):
            page = await self._graph_get(
                f"/{page_id}", access_token, {"fields": "id,name,instagram_business_account"}
            )
            resolved_page_id = str(page.get("id", page_id))
            page_name = str(page["name"]) if isinstance(page.get("name"), str) else None
            account = page.get("instagram_business_account")
            instagram_id = str(account["id"]) if isinstance(account, dict) and account.get("id") else None
            if instagram_id:
                selected = (resolved_page_id, page_name, instagram_id)
                break
            if selected is None:
                selected = (resolved_page_id, page_name, None)

        if selected is None:
            return DiscoveredAssets(None, None, None, None, permissions)
        page_id, page_name, instagram_id = selected
        instagram_username = None
        if instagram_id:
            profile = await self._graph_get(f"/{instagram_id}", access_token, {"fields": "id,username"})
            if isinstance(profile.get("username"), str):
                instagram_username = profile["username"]
        return DiscoveredAssets(page_id, page_name, instagram_id, instagram_username, permissions)

    async def _debug_token(self, access_token: str) -> tuple[set[str], set[str]]:
        app_access_token = (
            f"{self.settings.meta_app_id}|{self.settings.meta_app_secret.get_secret_value()}"
        )
        data = await self._graph_get(
            "/debug_token",
            app_access_token,
            {"input_token": access_token},
        )
        details = data.get("data", {}) if isinstance(data, dict) else {}
        if not isinstance(details, dict) or not details.get("is_valid"):
            raise MetaIntegrationError("Meta returned an invalid access token")
        if str(details.get("app_id")) != self.settings.meta_app_id:
            raise MetaIntegrationError("Meta access token belongs to a different app")
        scopes = {scope for scope in details.get("scopes", []) if isinstance(scope, str)}
        page_ids: set[str] = set()
        granular_scopes = details.get("granular_scopes", [])
        if isinstance(granular_scopes, list):
            for grant in granular_scopes:
                if not isinstance(grant, dict):
                    continue
                scope = grant.get("scope", grant.get("permission"))
                if isinstance(scope, str):
                    scopes.add(scope)
                if scope in {"pages_show_list", "pages_read_engagement"}:
                    page_ids.update(
                        str(target_id)
                        for target_id in grant.get("target_ids", [])
                        if isinstance(target_id, (str, int))
                    )
        return scopes, page_ids

    async def _graph_get(self, path: str, access_token: str, params: dict[str, str]) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=False) as client:
                response = await client.get(
                    f"{self.graph_base}{path}", params={**params, "access_token": access_token}
                )
                response.raise_for_status()
                data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise MetaIntegrationError("Meta asset verification failed") from exc
        if not isinstance(data, dict):
            raise MetaIntegrationError("Meta returned an unexpected response")
        return data

    def persist_successful_authorization(
        self, token_data: dict[str, Any], assets: DiscoveredAssets
    ) -> None:
        """Atomically replace the persisted Meta credential and discovered assets."""
        expires_at = None
        expires_in = token_data.get("expires_in")
        if isinstance(expires_in, (int, float)) and expires_in > 0:
            expires_at = utcnow() + timedelta(seconds=int(expires_in))
        capabilities = json.dumps(
            {"granted_permissions": sorted(assets.granted_permissions)}, separators=(",", ":")
        )
        encrypted = self.fernet.encrypt(token_data["access_token"].encode("utf-8")).decode("ascii")
        try:
            self.session.execute(delete(PlatformCredential).where(PlatformCredential.platform == "meta"))
            self.session.execute(delete(PlatformAccount).where(PlatformAccount.platform == "meta"))
            self.session.add(
                PlatformCredential(
                    platform="meta",
                    credential_kind="oauth_access",
                    token_ciphertext=encrypted,
                    token_type=str(token_data.get("token_type")) if token_data.get("token_type") else None,
                    expires_at=expires_at,
                )
            )
            if assets.page_id:
                self.session.add(
                    PlatformAccount(
                        platform="meta",
                        account_type="facebook_page",
                        external_id=assets.page_id,
                        display_name=assets.page_name,
                        capabilities_json=capabilities,
                    )
                )
            if assets.instagram_id:
                self.session.add(
                    PlatformAccount(
                        platform="meta",
                        account_type="instagram_professional",
                        external_id=assets.instagram_id,
                        display_name=assets.instagram_username,
                        parent_external_id=assets.page_id,
                        capabilities_json=capabilities,
                    )
                )
            self.session.commit()
        except Exception:
            self.session.rollback()
            raise

    def _upsert_credential(
        self, credential_kind: str, token: str, token_type: str | None, expires_at: datetime | None
    ) -> None:
        encrypted = self.fernet.encrypt(token.encode("utf-8")).decode("ascii")
        existing = self.session.scalar(
            select(PlatformCredential).where(
                PlatformCredential.platform == "meta",
                PlatformCredential.credential_kind == credential_kind,
            )
        )
        if existing:
            existing.token_ciphertext = encrypted
            existing.token_type = token_type
            existing.expires_at = expires_at
        else:
            self.session.add(
                PlatformCredential(
                    platform="meta",
                    credential_kind=credential_kind,
                    token_ciphertext=encrypted,
                    token_type=token_type,
                    expires_at=expires_at,
                )
            )
        self.session.commit()

    def _upsert_account(
        self, account_type: str, external_id: str, name: str | None, parent_id: str | None, capabilities: str
    ) -> None:
        existing = self.session.scalar(
            select(PlatformAccount).where(
                PlatformAccount.platform == "meta", PlatformAccount.external_id == external_id
            )
        )
        if existing:
            existing.account_type = account_type
            existing.display_name = name
            existing.parent_external_id = parent_id
            existing.capabilities_json = capabilities
        else:
            self.session.add(
                PlatformAccount(
                    platform="meta",
                    account_type=account_type,
                    external_id=external_id,
                    display_name=name,
                    parent_external_id=parent_id,
                    capabilities_json=capabilities,
                )
            )
        self.session.commit()


def load_status(session: Session) -> tuple[PlatformAccount | None, PlatformAccount | None, set[str]]:
    page = session.scalar(
        select(PlatformAccount).where(
            PlatformAccount.platform == "meta", PlatformAccount.account_type == "facebook_page"
        )
    )
    instagram = session.scalar(
        select(PlatformAccount).where(
            PlatformAccount.platform == "meta", PlatformAccount.account_type == "instagram_professional"
        )
    )
    capabilities: set[str] = set()
    if instagram:
        try:
            raw = json.loads(instagram.capabilities_json)
            capabilities = set(raw.get("granted_permissions", []))
        except (TypeError, ValueError):
            pass
    return page, instagram, capabilities
