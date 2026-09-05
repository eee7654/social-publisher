from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.storage.models import TemporaryMediaAsset, utcnow

ALLOWED_ASSETS = frozenset({"video.mp4", "cover.jpg"})


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _safe(settings: Settings, path: Path) -> bool:
    resolved = path.resolve()
    return any(resolved.is_relative_to(root.resolve()) for root in (settings.inbox_path, settings.database_path.parent))


def purge_expired(session: Session) -> None:
    session.execute(delete(TemporaryMediaAsset).where(TemporaryMediaAsset.expires_at <= utcnow()))
    session.commit()


def issue_media_url(settings: Settings, session: Session, job_id: str, asset_name: str, path: Path) -> str:
    if asset_name not in ALLOWED_ASSETS or not path.is_file() or not _safe(settings, path):
        raise ValueError("Unsupported publication media asset")
    purge_expired(session)
    token = secrets.token_urlsafe(32)
    session.add(TemporaryMediaAsset(token_hash=_hash(token), job_id=job_id, asset_name=asset_name, file_path=str(path.resolve()), expires_at=utcnow() + timedelta(seconds=settings.media_public_ttl_seconds)))
    session.commit()
    return f"{str(settings.public_base_url).rstrip('/')}/media/{token}/{asset_name}"


def resolve_media(settings: Settings, session: Session, token: str, asset_name: str) -> Path | None:
    purge_expired(session)
    asset = session.scalar(select(TemporaryMediaAsset).where(TemporaryMediaAsset.token_hash == _hash(token), TemporaryMediaAsset.asset_name == asset_name))
    if asset is None:
        return None
    path = Path(asset.file_path)
    return path if asset_name in ALLOWED_ASSETS and path.is_file() and _safe(settings, path) else None


def revoke_job_media(session: Session, job_id: str) -> None:
    session.execute(delete(TemporaryMediaAsset).where(TemporaryMediaAsset.job_id == job_id))
    session.commit()
