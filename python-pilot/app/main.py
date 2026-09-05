from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.media_routes import router as media_router
from app.storage.database import build_engine, create_session_factory, initialise_database

logger = logging.getLogger("elecio_publisher")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    engine = build_engine(settings)
    initialise_database(engine)
    app.state.engine = engine
    app.state.session_factory = create_session_factory(engine)
    yield
    engine.dispose()


app = FastAPI(
    title="ElecIO Publisher",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    debug=False,
    lifespan=lifespan,
)


@app.exception_handler(Exception)
async def safe_unhandled_exception(_request, _exc: Exception) -> JSONResponse:  # type: ignore[no-untyped-def]
    logger.exception("Unhandled application error")
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/health", include_in_schema=False)
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "elecio-publisher"}


app.include_router(media_router)
