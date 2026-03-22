"""
Feature Video — Script Generation + Video Pipeline

Pipeline per article:
1. GPT-4o generates a structured scene manifest (title_card / narration / data_callout)
2. OpenAI TTS synthesises per-scene audio (alloy voice, tts-1 model)
3. pydub concatenates all audio into narration.mp3
4. Pillow renders a PNG frame for each scene
5. FFmpeg assembles per-scene clips then muxes with audio → output.mp4

Job system: each request returns a job_id immediately; processing runs in a
background thread. Poll GET /video/status/{job_id} for progress.

Endpoints:
  GET  /health
  POST /video/generate   — queue a video job
  GET  /video/status/{job_id}
  GET  /video/download/{job_id}
"""

import json
import logging
import os
import re
import subprocess
import sys
import textwrap
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

import kafka_client
from llm_client import complete, tts

log = logging.getLogger(__name__)
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))


# ── JSON helpers (same pattern as feature-arc) ─────────────────────────────────

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def _parse_json(raw: str) -> Any:
    """Parse JSON from a GPT response, stripping markdown code fences if present."""
    raw = raw.strip()
    m = _FENCE_RE.match(raw)
    if m:
        raw = m.group(1).strip()
    return json.loads(raw)


# ── Config ─────────────────────────────────────────────────────────────────────

CACHE_DIR = Path(os.environ.get("VIDEO_CACHE_DIR", ".cache/video_jobs"))

VALID_SCENE_TYPES = {"title_card", "narration", "data_callout"}

FRAME_W, FRAME_H = 1280, 720


# ── Job store ──────────────────────────────────────────────────────────────────

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _init_job(job_id: str) -> None:
    with _jobs_lock:
        _jobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "progress": 0,
            "output_path": None,
            "error": None,
        }


def _update_job(job_id: str, **kwargs: Any) -> None:
    with _jobs_lock:
        _jobs[job_id].update(kwargs)


def _get_job(job_id: str) -> dict | None:
    with _jobs_lock:
        return dict(_jobs[job_id]) if job_id in _jobs else None


# ── FFmpeg check ───────────────────────────────────────────────────────────────

_ffmpeg_available: bool = False


def check_ffmpeg() -> bool:
    global _ffmpeg_available
    try:
        subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            check=True,
            timeout=5,
        )
        _ffmpeg_available = True
        log.info("FFmpeg is available")
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        log.warning(
            "FFmpeg not found in PATH — video assembly will fail. "
            "Install FFmpeg and add to PATH before running."
        )
        _ffmpeg_available = False
    return _ffmpeg_available


# ── Script generation ──────────────────────────────────────────────────────────

_SCENE_MANIFEST_SYSTEM = """You are a professional broadcast news scriptwriter for Economic Times.
Generate a structured scene manifest JSON array for a video news summary.

Rules:
- Total duration must be between 45 and 90 seconds
- Use 4-7 scenes
- Scene types: title_card, narration, data_callout
- title_card fields:   scene_id (int), type, text (str), duration_s (int)
- narration fields:    scene_id (int), type, spoken (str), duration_s (int)
- data_callout fields: scene_id (int), type, spoken (str), stat (str), duration_s (int)
- Return only a valid JSON array — no markdown fences, no prose

Example:
[
  {"scene_id": 1, "type": "title_card",   "text": "RBI Holds Rates",                            "duration_s": 3},
  {"scene_id": 2, "type": "narration",    "spoken": "The Reserve Bank of India kept...",         "duration_s": 15},
  {"scene_id": 3, "type": "data_callout", "spoken": "The repo rate remains unchanged.", "stat": "6.5%", "duration_s": 6}
]"""


def generate_script(title: str, text: str) -> list[dict]:
    """Call GPT-4o and return a validated scene manifest list."""
    prompt = f"Title: {title}\n\nArticle:\n{text[:3000]}"
    raw = complete(prompt, system=_SCENE_MANIFEST_SYSTEM, model="gpt-4o", max_tokens=1024)
    log.debug("Script raw response: %s", raw)
    scenes = _parse_json(raw)
    if not isinstance(scenes, list):
        raise ValueError(f"Expected a JSON array of scenes, got {type(scenes).__name__}")
    return scenes


# ── Frame generation (Pillow) ──────────────────────────────────────────────────


def _get_font(size: int):
    from PIL import ImageFont

    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        # Pillow < 9.2 load_default() doesn't accept size
        return ImageFont.load_default()


def _draw_centered_text(
    draw,
    text: str,
    y_center: int,
    fill: str,
    font,
    max_chars: int = 45,
) -> None:
    wrapped = textwrap.fill(text, width=max_chars)
    # Use multiline_textbbox to measure, then draw at explicit (x, y).
    # Avoids anchor="mm" which fails on some Pillow builds when the font
    # or text content triggers a different code path (e.g. long Unicode strings).
    bbox = draw.multiline_textbbox((0, 0), wrapped, font=font, align="center")
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = (FRAME_W - text_w) // 2
    y = y_center - text_h // 2
    draw.multiline_text((x, y), wrapped, fill=fill, font=font, align="center")


def create_scene_frame(scene: dict, output_path: Path) -> None:
    """Render a PNG frame for a scene using Pillow."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (FRAME_W, FRAME_H), "white")
    draw = ImageDraw.Draw(img)
    scene_type = scene.get("type", "narration")

    if scene_type == "title_card":
        font = _get_font(72)
        _draw_centered_text(draw, scene.get("text", ""), FRAME_H // 2, "#1A1A1A", font, max_chars=28)

    elif scene_type == "narration":
        # ET logo placeholder — red rectangle top-left
        draw.rectangle([20, 20, 110, 65], fill="#D42B2B")
        draw.text((52, 30), "ET", fill="white", font=_get_font(32))
        # Body text
        font = _get_font(38)
        _draw_centered_text(draw, scene.get("spoken", ""), FRAME_H // 2, "#1A1A1A", font, max_chars=52)

    elif scene_type == "data_callout":
        # Large coloured stat
        stat_font = _get_font(100)
        _draw_centered_text(draw, scene.get("stat", ""), FRAME_H // 2 - 90, "#1A5276", stat_font, max_chars=12)
        # Supporting text below
        body_font = _get_font(38)
        _draw_centered_text(draw, scene.get("spoken", ""), FRAME_H // 2 + 90, "#333333", body_font, max_chars=52)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(output_path))
    log.debug("Frame saved: %s", output_path)


# ── Audio generation ───────────────────────────────────────────────────────────


def generate_scene_audio(spoken_text: str, output_path: Path) -> None:
    """Synthesise TTS audio for one scene and write to output_path."""
    audio_bytes = tts(spoken_text, voice="alloy", model="tts-1")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(audio_bytes)
    log.debug("Audio saved: %s (%d bytes)", output_path, len(audio_bytes))


def concatenate_audio(audio_files: list[Path], output_path: Path) -> None:
    """Concatenate a list of MP3 files into one using pydub."""
    from pydub import AudioSegment

    combined = AudioSegment.empty()
    for f in audio_files:
        combined += AudioSegment.from_mp3(str(f))
    combined.export(str(output_path), format="mp3")
    log.debug("Concatenated %d audio files → %s", len(audio_files), output_path)


# ── Video assembly (FFmpeg) ────────────────────────────────────────────────────


def _fwd(path: Path) -> str:
    """Convert a Path to a forward-slash string for FFmpeg (required on Windows)."""
    return str(path).replace("\\", "/")


def _ffmpeg(cmd: list[str], **kwargs) -> None:
    """Run an FFmpeg command, raising RuntimeError with stderr on failure."""
    result = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        log.error("FFmpeg stderr:\n%s", result.stderr)
        raise RuntimeError(f"FFmpeg failed (exit {result.returncode}): {result.stderr[-500:]}")
    log.debug("FFmpeg ok: %s", " ".join(cmd[:6]))


def assemble_video(
    scenes: list[dict],
    frame_paths: list[Path],
    narration_path: Path,
    output_path: Path,
) -> None:
    """Build output.mp4 using FFmpeg filter_complex concat.

    Feeds each frame image directly as a timed input — no intermediate clip
    files, no clips_list.txt.  This sidesteps every Windows path issue with
    the concat demuxer (drive-letter colon parsed as URL scheme, backslash
    in list file, BOM/CRLF encoding).

    FFmpeg command structure (n=3 example):
        ffmpeg -y
          -loop 1 -t 3  -i frame_1.png
          -loop 1 -t 15 -i frame_2.png
          -loop 1 -t 6  -i frame_3.png
          -i narration.mp3
          -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0[outv]"
          -map [outv] -map 3:a
          -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest
          output.mp4
    """
    if not _ffmpeg_available:
        raise RuntimeError(
            "FFmpeg is not available. Install FFmpeg and add to PATH before running."
        )
    if not frame_paths:
        raise RuntimeError("No frame images to assemble — frame_paths is empty")

    n = len(frame_paths)

    # Build -loop/-t/-i inputs for every scene frame (absolute paths)
    video_inputs: list[str] = []
    for scene, frame_path in zip(scenes, frame_paths):
        duration = int(scene.get("duration_s", 5))
        video_inputs += ["-loop", "1", "-t", str(duration), "-i", _fwd(frame_path.resolve())]

    # Audio input comes after all video inputs (index n)
    audio_input = ["-i", _fwd(narration_path.resolve())]

    # filter_complex: concat all video streams, pass audio through
    concat_filter = "".join(f"[{i}:v]" for i in range(n)) + f"concat=n={n}:v=1:a=0[outv]"

    cmd = (
        ["ffmpeg", "-y"]
        + video_inputs
        + audio_input
        + [
            "-filter_complex", concat_filter,
            "-map", "[outv]",
            "-map", f"{n}:a",
            "-c:v", "libx264", "-tune", "stillimage",
            "-pix_fmt", "yuv420p", "-r", "24",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            _fwd(output_path.resolve()),
        ]
    )

    log.info("Assembling video: %d scenes → %s", n, output_path)
    _ffmpeg(cmd)
    log.info("Video assembled: %s", output_path)


# ── Job runner ─────────────────────────────────────────────────────────────────


def run_job(job_id: str, article_id: str, title: str, text: str) -> None:
    """Full pipeline: script → audio → frames → video. Runs in a background thread."""
    job_dir = CACHE_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    _update_job(job_id, status="processing", progress=5)
    log.info("Job %s: starting for article_id=%s", job_id, article_id)

    # 1. Script generation
    try:
        scenes = generate_script(title, text)
    except Exception as exc:
        log.exception("Job %s: script generation failed", job_id)
        _update_job(job_id, status="failed", error=f"Script generation failed: {exc}")
        return

    _update_job(job_id, progress=20)
    log.info("Job %s: generated %d scenes", job_id, len(scenes))

    # 2. Per-scene audio
    audio_files: list[Path] = []
    for scene in scenes:
        if "spoken" not in scene:
            continue
        audio_path = job_dir / f"audio_{scene['scene_id']}.mp3"
        try:
            generate_scene_audio(scene["spoken"], audio_path)
            audio_files.append(audio_path)
        except Exception as exc:
            log.warning("Job %s: TTS failed for scene %d: %s", job_id, scene["scene_id"], exc)

    _update_job(job_id, progress=45)

    # 3. Concatenate audio → narration.mp3
    narration_path = job_dir / "narration.mp3"
    if audio_files:
        try:
            concatenate_audio(audio_files, narration_path)
        except Exception as exc:
            log.exception("Job %s: audio concat failed", job_id)
            _update_job(job_id, status="failed", error=f"Audio concat failed: {exc}")
            return

    _update_job(job_id, progress=60)

    # 4. Create PNG frames
    frame_paths: list[Path] = []
    for scene in scenes:
        frame_path = job_dir / f"frame_{scene['scene_id']}.png"
        try:
            create_scene_frame(scene, frame_path)
            frame_paths.append(frame_path)
        except Exception:
            # log.exception prints the full traceback — critical for diagnosing
            # silent Pillow failures (anchor bugs, font issues, Unicode, etc.)
            log.exception("Job %s: frame creation failed for scene %d", job_id, scene.get("scene_id"))

    if not frame_paths:
        msg = "All frame renders failed — check logs above for Pillow traceback"
        log.error("Job %s: %s", job_id, msg)
        _update_job(job_id, status="failed", error=msg)
        return

    log.info("Job %s: created %d/%d frames", job_id, len(frame_paths), len(scenes))
    _update_job(job_id, progress=75)

    # 5. Video assembly
    output_path = job_dir / "output.mp4"
    try:
        assemble_video(scenes, frame_paths, narration_path, output_path)
        _update_job(job_id, status="done", progress=100, output_path=str(output_path))
        log.info("Job %s: done → %s", job_id, output_path)
    except Exception as exc:
        log.exception("Job %s: video assembly failed", job_id)
        _update_job(job_id, status="failed", error=f"Video assembly failed: {exc}")


# ── FastAPI app ────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    check_ffmpeg()
    yield


app = FastAPI(title="Feature: Video", version="1.0.0", lifespan=lifespan)


class VideoRequest(BaseModel):
    article_id: str
    title: str
    text: str


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "feature-video", "ffmpeg": _ffmpeg_available}


@app.post("/video/generate")
async def video_generate(req: VideoRequest) -> dict:
    job_id = str(uuid.uuid4())
    _init_job(job_id)
    t = threading.Thread(
        target=run_job,
        args=(job_id, req.article_id, req.title, req.text),
        daemon=True,
    )
    t.start()
    log.info("Video job %s queued for article_id=%s", job_id, req.article_id)
    return {"job_id": job_id, "status": "queued"}


@app.get("/video/status/{job_id}")
async def video_status(job_id: str) -> dict:
    job = _get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found")
    return job


@app.get("/video/download/{job_id}")
async def video_download(job_id: str) -> FileResponse:
    job = _get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found")
    if job["status"] != "done":
        raise HTTPException(
            status_code=409,
            detail=f"Job is '{job['status']}', not done yet",
        )
    output_path = Path(job["output_path"])
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="Output file missing from disk")
    return FileResponse(
        str(output_path),
        media_type="video/mp4",
        filename=f"et-news-{job_id[:8]}.mp4",
    )


# ── Kafka worker ───────────────────────────────────────────────────────────────


def kafka_worker() -> None:
    topic = os.environ.get("KAFKA_TOPIC_VIDEO_JOBS", "video-jobs")
    log.info("Video Kafka worker consuming '%s'", topic)
    for msg in kafka_client.consume(topic, group_id="feature-video"):
        try:
            article_id = str(msg.get("article_id", ""))
            title = msg.get("title", "News Update")
            text = msg.get("text") or msg.get("briefing", "")
            job_id = str(uuid.uuid4())
            _init_job(job_id)
            run_job(job_id, article_id, title, text)
        except Exception as exc:
            log.exception("Video Kafka job failed: %s", exc)


if __name__ == "__main__":
    import uvicorn

    t = threading.Thread(target=kafka_worker, daemon=True)
    t.start()
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("FEATURE_VIDEO_PORT", 8003)),
    )
