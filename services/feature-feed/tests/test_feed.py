"""
Unit tests for services/feature-feed/main.py

All OpenAI and Qdrant calls are mocked — no real API calls are made.
"""

from __future__ import annotations

import copy
import math
import os
import sys
import time

# Add services/feature-feed/ to sys.path so `import main` works
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Set required env vars before importing main (llm_client reads OPENAI_API_KEY at call time,
# but openai SDK is imported at module level and validates the key lazily).
os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("REDIS_HOST", "localhost")

import numpy as np
import pytest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Shared test fixtures
# ---------------------------------------------------------------------------

FAKE_VEC: np.ndarray = np.ones(1536, dtype=np.float32) * 0.1
FAKE_VEC_LIST: list[float] = FAKE_VEC.tolist()
FAKE_VEC_BYTES: bytes = FAKE_VEC.tobytes()

NOW = time.time()

FAKE_ARTICLES = [
    {
        "score": 0.9,
        "article_id": "art-1",
        "title": "Test Article Recent",
        "topic": "markets",
        "section": "markets",
        "pub_ts": NOW - 1 * 3600,   # 1 hour ago
    },
    {
        "score": 0.8,
        "article_id": "art-2",
        "title": "Test Article Old",
        "topic": "tech",
        "section": "tech",
        "pub_ts": NOW - 48 * 3600,  # 48 hours ago
    },
]


class FakeRedis:
    """In-memory stand-in for redis.Redis."""

    def __init__(self) -> None:
        self._store: dict[str, bytes] = {}

    def get(self, key: str) -> bytes | None:
        return self._store.get(key)

    def set(self, key: str, value: bytes, **kwargs) -> None:
        self._store[key] = value


@pytest.fixture()
def fake_redis() -> FakeRedis:
    return FakeRedis()


@pytest.fixture()
def app_client(fake_redis: FakeRedis):
    """
    Yields (TestClient, fake_redis).

    Patches:
      - main._seed_qdrant  → no-op (skip real Qdrant + OpenAI on startup)
      - main.get_redis     → returns fake_redis
      - main.embed         → returns FAKE_VEC_LIST
    """
    with patch("main._seed_qdrant"):
        with patch("main.get_redis", return_value=fake_redis):
            with patch("main.embed", return_value=FAKE_VEC_LIST):
                import main as feed_main  # noqa: PLC0415 — lazy import intentional

                with TestClient(feed_main.app) as client:
                    yield client, fake_redis


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_health(app_client):
    client, _ = app_client
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "service": "feed"}


def test_onboard_creates_vector(app_client):
    client, fake_redis = app_client
    resp = client.post(
        "/onboard",
        json={
            "user_id": "test_user",
            "role": "analyst",
            "sectors": ["tech", "banking"],
            "tickers": ["INFY", "HDFC"],
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["user_id"] == "test_user"
    # Confirm Redis key was written
    raw = fake_redis.get("uvec:test_user")
    assert raw is not None
    vec = np.frombuffer(raw, dtype=np.float32)
    assert vec.shape == (1536,)


def test_ema_update(app_client):
    """After two engagement signals the stored user vector must differ from the initial one."""
    client, fake_redis = app_client

    # Seed a known user vector
    fake_redis.set("uvec:test_user", FAKE_VEC_BYTES)
    initial_vec = np.frombuffer(fake_redis.get("uvec:test_user"), dtype=np.float32).copy()

    # Mock Qdrant retrieve so engage can fetch article embedding
    mock_point = MagicMock()
    mock_point.vector = FAKE_VEC_LIST
    mock_qdrant = MagicMock()
    mock_qdrant.retrieve.return_value = [mock_point]

    with patch("vector_store.get_client", return_value=mock_qdrant):
        r1 = client.post(
            "/engage",
            json={"user_id": "test_user", "article_id": "art-1", "signal": "opened"},
        )
        assert r1.status_code == 200

        r2 = client.post(
            "/engage",
            json={"user_id": "test_user", "article_id": "art-1", "signal": "shared"},
        )
        assert r2.status_code == 200

    final_vec = np.frombuffer(fake_redis.get("uvec:test_user"), dtype=np.float32).copy()
    assert not np.array_equal(initial_vec, final_vec), "Vector should change after engagement"


def test_feed_returns_articles(app_client):
    client, fake_redis = app_client

    # Ensure a user vector is present in Redis
    fake_redis.set("uvec:test_user", FAKE_VEC_BYTES)

    with patch("vector_store.search", return_value=copy.deepcopy(FAKE_ARTICLES)):
        resp = client.get("/feed/test_user")

    assert resp.status_code == 200
    data = resp.json()
    assert "articles" in data
    assert len(data["articles"]) > 0
    # Each article should have a final_score and core payload fields
    article = data["articles"][0]
    assert "title" in article
    assert "topic" in article
    assert "final_score" in article


def test_recency_favours_recent():
    """Pure scoring test — no mocks needed."""
    from main import _recency_score  # noqa: PLC0415

    recent = _recency_score(time.time() - 1 * 3600)   # 1 hour ago
    old = _recency_score(time.time() - 48 * 3600)     # 48 hours ago

    assert recent > old, (
        f"Recent article should score higher: recent={recent:.4f}, old={old:.4f}"
    )
    # Sanity-check the values
    assert abs(recent - math.exp(-1 / 24)) < 1e-6
    assert abs(old - math.exp(-2)) < 1e-6


def test_unknown_signal_raises_422(app_client):
    client, _ = app_client
    resp = client.post(
        "/engage",
        json={
            "user_id": "test_user",
            "article_id": "art-1",
            "signal": "invalid_signal",
        },
    )
    assert resp.status_code == 422
