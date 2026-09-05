from __future__ import annotations

import asyncio, json, subprocess
from datetime import datetime, timezone
from pathlib import Path

import httpx
from app.config import get_settings
from app.media import issue_media_url, revoke_job_media
from app.publishers.base import PublishPost
from app.publishers.instagram import InstagramPublisher, MetaApiError, PublishAmbiguous
from app.storage.database import build_engine, create_session_factory, initialise_database

def log(path: Path, event: str, **data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.open("a", encoding="utf-8").write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "event": event, **data}) + "\n")

def probe(path: Path) -> dict:
    raw = subprocess.run(["ffprobe", "-v", "error", "-of", "json", "-show_format", "-show_streams", str(path)], capture_output=True, text=True, check=True)
    data = json.loads(raw.stdout); video = next((x for x in data["streams"] if x.get("codec_type") == "video"), None); audio = next((x for x in data["streams"] if x.get("codec_type") == "audio"), None)
    if not video or not audio or video.get("codec_name") != "h264" or audio.get("codec_name") != "aac": raise ValueError("Requires H.264 video and AAC audio")
    w,h,d = int(video["width"]),int(video["height"]),float(data["format"]["duration"])
    if w >= h or not .55 <= w/h <= .65 or not 3 <= d <= 900: raise ValueError("Not Reel-compatible vertical video")
    n,den = (int(x) for x in video["avg_frame_rate"].split("/"))
    return {"resolution":f"{w}x{h}","duration":d,"video_codec":"h264","audio_codec":"aac","fps":n/den,"file_size":path.stat().st_size}

async def run() -> int:
    settings=get_settings(); job=settings.inbox_path/"r01"; video=job/"video.mp4"; caption_path=job/"caption.txt"; source=next((x for x in (job/"cover.jpg",job/"cover.jpeg",job/"cover.png") if x.is_file()),None)
    if not video.is_file() or not caption_path.is_file() or source is None: raise FileNotFoundError("r01 files missing")
    caption=caption_path.read_text(encoding="utf-8"); metadata=probe(video); cover=settings.database_path.parent/"r01-cover.jpg"
    if source.suffix.lower() in {".png", ".webp"}: subprocess.run(["ffmpeg","-y","-i",str(source),"-frames:v","1","-q:v","2",str(cover)],capture_output=True,check=True)
    else: cover=source
    engine=build_engine(settings); initialise_database(engine); session=create_session_factory(engine)(); logs=settings.logs_path/"r01.jsonl"
    try:
        vu=issue_media_url(settings,session,"r01","video.mp4",video); cu=issue_media_url(settings,session,"r01","cover.jpg",cover)
        async with httpx.AsyncClient(timeout=30) as client:
            for url in (vu,cu):
                if (await client.get(url)).status_code != 200: raise RuntimeError("Temporary media unavailable")
        publisher=InstagramPublisher(settings); container=await publisher.create_reel_container(PublishPost(caption=caption,video_url=vu,cover_url=cu)); log(logs,"container_created",container_id=container)
        status=await publisher.wait_until_finished(container); log(logs,"container_terminal",container_id=container,status=status.get("status_code"))
        print(json.dumps({"instagram_username":settings.meta_ig_username,"video_metadata":metadata,"custom_cover_loaded":True,"caption_first_150":caption[:150],"creation_container_status":status.get("status_code")},ensure_ascii=False))
        if status.get("status_code") != "FINISHED": print(json.dumps({"container_id":container,"status":status.get("status_code"),"error":status.get("status")},ensure_ascii=False)); return 2
        try: media_id=await publisher.publish_container(container)
        except PublishAmbiguous:
            existing=await publisher.find_recent_matching_media(caption)
            if existing is None: log(logs,"publish_ambiguous",container_id=container); print(json.dumps({"container_id":container,"status":"PUBLISH_AMBIGUOUS_NO_RETRY"})); return 3
            media_id=existing.media_id
        media=await publisher.get_published_media(media_id); log(logs,"published",container_id=container,media_id=media.media_id,status="FINISHED"); revoke_job_media(session,"r01")
        print(json.dumps({"event":"INSTAGRAM_R01_PUBLISHED","instagram_username":settings.meta_ig_username,"media_id":media.media_id,"permalink":media.permalink,"publication_timestamp":media.timestamp,"container_id":container,"final_processing_status":"FINISHED","custom_cover_used":True,"share_to_feed_enabled":True},ensure_ascii=False)); return 0
    except MetaApiError as exc: log(logs,"meta_error",error=exc.sanitized); print(json.dumps({"event":"META_PUBLICATION_ERROR","error":exc.sanitized},ensure_ascii=False)); return 2
    finally: session.close(); engine.dispose()

if __name__ == "__main__": raise SystemExit(asyncio.run(run()))
