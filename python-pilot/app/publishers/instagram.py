from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from app.config import Settings
from app.publishers.base import PublishPost, Publisher


class MetaApiError(RuntimeError):
    def __init__(self, payload: dict[str, Any] | None = None) -> None:
        error = payload.get("error", {}) if isinstance(payload, dict) else {}
        self.sanitized = {key: error[key] for key in ("message", "type", "code", "error_subcode", "fbtrace_id") if key in error}
        super().__init__("Meta API request failed")


class PublishAmbiguous(RuntimeError):
    pass


@dataclass(frozen=True)
class PublishedMedia:
    media_id: str
    permalink: str | None
    timestamp: str | None


class InstagramPublisher(Publisher):
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.base = f"https://graph.facebook.com/{settings.meta_graph_version}"

    async def _request(self, method: str, path: str, data: dict[str, str]) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.request(method, f"{self.base}{path}", params={**data, "access_token": self.settings.meta_system_user_token.get_secret_value()})
        except httpx.TransportError as exc:
            raise PublishAmbiguous("Meta transport failure") from exc
        try:
            body = response.json()
        except ValueError:
            body = None
        if response.is_error or not isinstance(body, dict):
            raise MetaApiError(body)
        return body

    async def create_reel_container(self, post: PublishPost) -> str:
        if not post.video_url or not post.cover_url:
            raise ValueError("Reel requires public video and cover URLs")
        body = await self._request("POST", f"/{self.settings.meta_ig_user_id}/media", {"media_type": "REELS", "video_url": post.video_url, "cover_url": post.cover_url, "caption": post.caption, "share_to_feed": "true"})
        if not isinstance(body.get("id"), str):
            raise MetaApiError(body)
        return body["id"]

    async def get_container_status(self, container_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/{container_id}", {"fields": "id,status_code,status"})

    async def publish_container(self, container_id: str) -> str:
        body = await self._request("POST", f"/{self.settings.meta_ig_user_id}/media_publish", {"creation_id": container_id})
        if not isinstance(body.get("id"), str):
            raise MetaApiError(body)
        return body["id"]

    async def wait_until_finished(self, container_id: str, timeout: int = 600) -> dict[str, Any]:
        import asyncio
        end = asyncio.get_running_loop().time() + timeout
        while True:
            status = await self.get_container_status(container_id)
            if status.get("status_code") in {"FINISHED", "ERROR"}:
                return status
            if asyncio.get_running_loop().time() >= end:
                raise TimeoutError("Container processing timeout")
            await asyncio.sleep(10)

    async def get_published_media(self, media_id: str) -> PublishedMedia:
        body = await self._request("GET", f"/{media_id}", {"fields": "id,permalink,timestamp"})
        return PublishedMedia(media_id, body.get("permalink"), body.get("timestamp"))

    async def find_recent_matching_media(self, caption: str) -> PublishedMedia | None:
        body = await self._request("GET", f"/{self.settings.meta_ig_user_id}/media", {"fields": "id,caption,permalink,timestamp", "limit": "10"})
        for media in body.get("data", []):
            if isinstance(media, dict) and media.get("caption") == caption and isinstance(media.get("id"), str):
                return PublishedMedia(media["id"], media.get("permalink"), media.get("timestamp"))
        return None

    async def publish(self, post: PublishPost) -> str:
        container_id = await self.create_reel_container(post)
        status = await self.wait_until_finished(container_id)
        if status.get("status_code") != "FINISHED":
            raise MetaApiError(status)
        return await self.publish_container(container_id)
