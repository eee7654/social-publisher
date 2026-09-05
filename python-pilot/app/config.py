from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import AnyHttpUrl, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """System-user runtime settings; no browser OAuth or app secret is required."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    meta_system_user_token: SecretStr
    meta_page_id: str = Field(min_length=1)
    meta_ig_user_id: str = Field(min_length=1)
    meta_ig_username: str = Field(min_length=1)
    meta_graph_version: str = Field(default="v26.0", pattern=r"^v\d+\.\d+$")
    public_base_url: AnyHttpUrl
    database_path: Path = Path("data/publisher.db")
    inbox_path: Path = Path("inbox")
    logs_path: Path = Path("logs")
    media_public_ttl_seconds: int = Field(default=7200, ge=300, le=86400)

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.database_path.resolve().as_posix()}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
