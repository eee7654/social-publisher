from collections.abc import Callable

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from app.config import get_settings
from app.media import resolve_media

router = APIRouter()


@router.get("/media/{token}/{asset_name}", include_in_schema=False)
def temporary_media(request: Request, token: str, asset_name: str) -> Response:
    factory: Callable[[], Session] = request.app.state.session_factory
    session = factory()
    try:
        path = resolve_media(get_settings(), session, token, asset_name)
    finally:
        session.close()
    if path is None:
        return Response(status_code=404)
    return FileResponse(path, media_type="video/mp4" if asset_name == "video.mp4" else "image/jpeg", headers={"Cache-Control": "no-store"})
