from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class PublishPost:
    caption: str
    video_path: Path | None = None
    video_url: str | None = None
    cover_path: Path | None = None
    cover_url: str | None = None


class Publisher(ABC):
    @abstractmethod
    async def publish(self, post: PublishPost) -> str:
        """Publish only when a future explicit workflow calls this method."""

