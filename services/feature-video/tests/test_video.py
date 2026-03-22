"""
Tests for feature-video: script generation, JSON parsing, job lifecycle.

All OpenAI calls, file system writes, and FFmpeg invocations are mocked.
"""

import json
import os
import sys
import tempfile
from unittest.mock import MagicMock, patch

import pytest

# ── Environment before any imports ────────────────────────────────────────────
os.environ.setdefault("OPENAI_API_KEY", "test-key")
# Use a real temp directory so CACHE_DIR.mkdir() in lifespan succeeds
os.environ.setdefault(
    "VIDEO_CACHE_DIR",
    os.path.join(tempfile.gettempdir(), "test_et_video_jobs"),
)

# Add service root so `import main` resolves
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402
from main import VALID_SCENE_TYPES, _parse_json, generate_script  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# ── Sample data ────────────────────────────────────────────────────────────────

SAMPLE_SCENES = [
    {"scene_id": 1, "type": "title_card", "text": "RBI Holds Repo Rate", "duration_s": 3},
    {
        "scene_id": 2,
        "type": "narration",
        "spoken": "The Reserve Bank of India kept the repo rate unchanged at 6.5 percent.",
        "duration_s": 15,
    },
    {
        "scene_id": 3,
        "type": "data_callout",
        "spoken": "Repo rate remains unchanged amid easing inflation.",
        "stat": "6.5%",
        "duration_s": 6,
    },
]


# ── Fixtures ───────────────────────────────────────────────────────────────────


@pytest.fixture
def client():
    """TestClient with FFmpeg check patched out (not required for tests)."""
    with patch.object(main, "check_ffmpeg", return_value=False):
        with TestClient(main.app) as c:
            yield c


# ── Tests ──────────────────────────────────────────────────────────────────────


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["service"] == "feature-video"


def test_parse_json_strips_fences():
    # Fenced with ```json
    fenced_json = '```json\n[{"scene_id": 1, "type": "title_card"}]\n```'
    result = _parse_json(fenced_json)
    assert result == [{"scene_id": 1, "type": "title_card"}]

    # Fenced without language tag
    fenced_plain = '```\n{"key": "value"}\n```'
    assert _parse_json(fenced_plain) == {"key": "value"}

    # Plain JSON passes through unchanged
    plain = json.dumps(SAMPLE_SCENES)
    assert _parse_json(plain) == SAMPLE_SCENES


def test_script_generation_schema():
    """GPT-4o response is parsed into a valid scene manifest list."""
    mock_response = json.dumps(SAMPLE_SCENES)
    with patch("main.complete", return_value=mock_response):
        scenes = generate_script("RBI Rate Decision", "RBI kept repo rate at 6.5%.")

    assert isinstance(scenes, list)
    assert len(scenes) == 3

    for scene in scenes:
        assert "scene_id" in scene
        assert "type" in scene
        assert "duration_s" in scene

    # title_card must have 'text'
    assert "text" in scenes[0]
    # narration must have 'spoken'
    assert "spoken" in scenes[1]
    # data_callout must have 'spoken' and 'stat'
    assert "spoken" in scenes[2]
    assert "stat" in scenes[2]


def test_scene_types_valid():
    """All scene types in the sample manifest are from the allowed set."""
    for scene in SAMPLE_SCENES:
        assert scene["type"] in VALID_SCENE_TYPES, (
            f"Unknown scene type: {scene['type']!r}"
        )

    # Sanity check the allowed set itself
    assert VALID_SCENE_TYPES == {"title_card", "narration", "data_callout"}


def test_job_created_on_generate(client):
    """POST /video/generate returns a job_id and status=queued without blocking."""
    with patch("threading.Thread") as mock_thread:
        mock_thread.return_value = MagicMock()
        resp = client.post(
            "/video/generate",
            json={
                "article_id": "art_001",
                "title": "RBI Rate Decision",
                "text": "The Reserve Bank of India kept repo rate unchanged at 6.5%.",
            },
        )

    assert resp.status_code == 200
    data = resp.json()
    assert "job_id" in data
    assert len(data["job_id"]) == 36  # UUID4 format
    assert data["status"] == "queued"

    # Verify the thread was actually constructed and started
    mock_thread.assert_called_once()
    mock_thread.return_value.start.assert_called_once()


def test_status_endpoint(client):
    """GET /video/status/{job_id} returns the stored job dict."""
    job_id = "test-job-status-001"
    with main._jobs_lock:
        main._jobs[job_id] = {
            "job_id": job_id,
            "status": "processing",
            "progress": 45,
            "output_path": None,
            "error": None,
        }

    resp = client.get(f"/video/status/{job_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["job_id"] == job_id
    assert data["status"] == "processing"
    assert data["progress"] == 45
    assert data["output_path"] is None
    assert data["error"] is None


def test_unknown_job_returns_404(client):
    """GET /video/status/{job_id} with unknown id returns 404."""
    resp = client.get("/video/status/nonexistent-job-id-xyz-404")
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()
