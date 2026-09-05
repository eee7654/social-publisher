from __future__ import annotations

import html
import time
from collections import defaultdict, deque
from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.meta.schemas import AccountSummary, CapabilitySummary, MetaStatusResponse
from app.meta.service import (
    REQUIRED_PERMISSIONS,
    MetaClient,
    MetaIntegrationError,
    build_authorization_url,
    consume_state,
    load_status,
)

router = APIRouter(prefix="/auth/meta", tags=["meta"])
CALLBACK_HEADERS = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}


class AuthRateLimiter:
    """Small in-process guard for the interactive start endpoint; no external infra required."""

    def __init__(self, limit: int = 10, window_seconds: int = 60) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self.events: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, client: str) -> bool:
        now = time.monotonic()
        event_list = self.events[client]
        while event_list and now - event_list[0] >= self.window_seconds:
            event_list.popleft()
        if len(event_list) >= self.limit:
            return False
        event_list.append(now)
        return True


rate_limiter = AuthRateLimiter()


def get_db(request: Request) -> Session:
    factory: Callable[[], Session] = request.app.state.session_factory
    session = factory()
    try:
        yield session
    finally:
        session.close()


@router.get("", include_in_schema=False)
def start_meta_auth(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> RedirectResponse:
    client = request.client.host if request.client else "unknown"
    if not rate_limiter.allow(client):
        raise HTTPException(status_code=429, detail="Too many authorization attempts. Try again shortly.")
    return RedirectResponse(build_authorization_url(settings, db), status_code=302)


@router.get("/callback", include_in_schema=False)
async def meta_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> HTMLResponse:
    # Provider error details and callback parameters must never be reflected or logged.
    if not state or not consume_state(db, state):
        return HTMLResponse(
            "<h1>Meta authorization session is invalid or expired.</h1>", status_code=400, headers=CALLBACK_HEADERS
        )
    if error or not code:
        return HTMLResponse("<h1>Meta authorization was not completed.</h1>", status_code=400, headers=CALLBACK_HEADERS)

    client = MetaClient(settings, db)
    try:
        token_data = await client.exchange_code(code)
        assets = await client.discover_assets(token_data["access_token"])
        client.persist_successful_authorization(token_data, assets)
    except MetaIntegrationError:
        return HTMLResponse(
            "<h1>Meta authorization could not be verified.</h1>", status_code=502, headers=CALLBACK_HEADERS
        )
    # Move the browser to a query-free URL so the authorization code is not retained as a referer.
    return RedirectResponse(url="/auth/meta/result", status_code=303, headers=CALLBACK_HEADERS)


@router.get("/result", include_in_schema=False)
def meta_result(db: Session = Depends(get_db)) -> HTMLResponse:
    page, instagram, granted = load_status(db)
    missing = sorted(REQUIRED_PERMISSIONS - granted)
    page_name = html.escape(page.display_name if page and page.display_name else "Not found")
    instagram_name = html.escape(
        f"@{instagram.display_name}" if instagram and instagram.display_name else "Not found"
    )
    publishing = "Available" if "instagram_content_publish" in granted and instagram else "Not Available"
    missing_html = html.escape(", ".join(missing)) if missing else "None"
    return HTMLResponse(
        "<h1>Meta authorization successful.</h1>"
        f"<p>Facebook Page: {page_name}</p>"
        f"<p>Instagram account: {instagram_name}</p>"
        f"<p>Instagram publishing access: {publishing}</p>"
        f"<p>Missing required permissions: {missing_html}</p>",
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )


@router.get("/status", response_model=MetaStatusResponse)
def meta_status(db: Session = Depends(get_db)) -> MetaStatusResponse:
    page, instagram, granted = load_status(db)
    missing = sorted(REQUIRED_PERMISSIONS - granted)
    return MetaStatusResponse(
        configured=page is not None and instagram is not None,
        page=AccountSummary(id=page.external_id, name=page.display_name) if page else None,
        instagram=AccountSummary(id=instagram.external_id, name=instagram.display_name) if instagram else None,
        capabilities=CapabilitySummary(
            content_publish="instagram_content_publish" in granted and instagram is not None,
            messages="instagram_manage_messages" in granted and instagram is not None,
            missing_permissions=missing,
        ),
    )
