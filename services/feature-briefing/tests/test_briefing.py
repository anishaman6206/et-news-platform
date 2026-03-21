"""
Unit tests for services/feature-briefing/main.py

All OpenAI and Qdrant calls are mocked — no real API calls made.
"""

from __future__ import annotations

import json
import os
import sys

# Add services/feature-briefing/ so `import main` works
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("REDIS_HOST", "localhost")

import pytest
from unittest.mock import MagicMock, patch, call
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Shared fixtures / constants
# ---------------------------------------------------------------------------

FAKE_VEC = [0.1] * 1536

FAKE_ARTICLES = [
    {
        "score": 0.9,
        "article_id": 1,
        "title": "RBI repo rate decision March 2026",
        "section": "economy",
        "pub_ts": 1_700_000_000.0,
    },
    {
        "score": 0.8,
        "article_id": 2,
        "title": "SEBI tightens mutual fund regulations",
        "section": "markets",
        "pub_ts": 1_700_000_100.0,
    },
]

FAKE_BRIEFING = {
    "summary": "RBI held rates steady while SEBI tightened fund rules.",
    "key_developments": [
        {"text": "RBI kept repo rate at 6.5%.", "source_ids": [1]},
        {"text": "SEBI issued new mutual fund norms.", "source_ids": [2]},
    ],
    "stakeholders": [
        {"name": "RBI", "role": "regulator", "sentiment": "cautious"}
    ],
    "open_questions": ["Will rates change next quarter?"],
    "what_to_watch": ["Next MPC meeting", "SEBI circular follow-up"],
}
FAKE_BRIEFING_JSON = json.dumps(FAKE_BRIEFING)


class FakeRedis:
    """In-memory stand-in for redis.Redis."""

    def __init__(self) -> None:
        self._store: dict[str, bytes] = {}

    def get(self, key: str) -> bytes | None:
        return self._store.get(key)

    def set(self, key: str, value: bytes, **kwargs) -> None:
        self._store[key] = value

    def setex(self, key: str, ttl: int, value: bytes) -> None:
        self._store[key] = value


@pytest.fixture()
def fake_redis() -> FakeRedis:
    return FakeRedis()


@pytest.fixture()
def app_client(fake_redis: FakeRedis):
    """
    Yields (TestClient, fake_redis).

    Patches:
      - main.get_redis  → returns fake_redis for every call
      - main.embed      → returns FAKE_VEC (avoids OpenAI at import time)
    """
    with patch("main.get_redis", return_value=fake_redis):
        with patch("main.embed", return_value=FAKE_VEC):
            import main as briefing_main  # noqa: PLC0415

            with TestClient(briefing_main.app) as client:
                yield client, fake_redis


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _first_sse_payload(sse_text: str) -> str:
    """Extract the JSON string from the first SSE data line."""
    for line in sse_text.splitlines():
        if line.startswith("data: ") and "[DONE]" not in line:
            return line[len("data: "):]
    return ""


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_health(app_client):
    client, _ = app_client
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "service": "feature-briefing"}


def test_rrf_merge():
    """
    Article 'a' appears in both semantic (rank 0) and keyword (rank 0).
    Articles 'b' and 'c' appear in only one list each.
    'a' must rank first.

    Score_a = 1/(60+0) + 1/(60+0) = 2/60 ≈ 0.0333
    Score_b = 1/(60+1)             ≈ 0.0164
    Score_c =             1/(60+1) ≈ 0.0164
    """
    from main import _rrf_merge, RRF_K  # noqa: PLC0415

    semantic = [
        {"title": "Article A", "article_id": "a"},
        {"title": "Article B", "article_id": "b"},
    ]
    keyword = [
        {"title": "Article A", "article_id": "a"},
        {"title": "Article C", "article_id": "c"},
    ]

    result = _rrf_merge(semantic, keyword, top_n=10)
    ids = [r["article_id"] for r in result]

    assert ids[0] == "a", "Article in both lists should rank first"
    assert set(ids) == {"a", "b", "c"}, "All three unique articles should appear"
    assert len(result) == 3

    # Verify the formula numerically for the top article
    expected_score_a = 1.0 / (RRF_K + 0) + 1.0 / (RRF_K + 0)
    expected_score_b = 1.0 / (RRF_K + 1)
    assert expected_score_a > expected_score_b


def test_dedup_removes_similar():
    """Two titles with >60% Jaccard overlap → only the longer one is kept."""
    from main import _deduplicate  # noqa: PLC0415

    articles = [
        {"title": "RBI keeps repo rate unchanged at six percent", "section": "economy"},
        # adds two extra words → longer, should be kept
        {"title": "RBI keeps repo rate unchanged at six percent in March meeting", "section": "economy"},
    ]
    result = _deduplicate(articles)

    assert len(result) == 1, "Near-duplicate titles should collapse to one"
    assert "March" in result[0]["title"], "Longer title should be retained"


def test_dedup_keeps_different():
    """Two titles with low overlap → both are kept."""
    from main import _deduplicate  # noqa: PLC0415

    articles = [
        {"title": "RBI repo rate decision", "section": "economy"},
        {"title": "Infosys quarterly earnings beat estimates", "section": "tech"},
    ]
    result = _deduplicate(articles)
    assert len(result) == 2, "Distinct articles must not be merged"


def test_cache_hit_skips_llm(app_client):
    """Second call with the same topic must be served from Redis, not GPT-4o."""
    client, fake_redis = app_client
    topic = "RBI rates March 2026"

    # First call — cache miss → LLM is invoked
    with patch("main._hybrid_retrieve", return_value=list(FAKE_ARTICLES)):
        with patch("main.complete", return_value=FAKE_BRIEFING_JSON) as mock_llm:
            resp1 = client.post(
                "/briefing/generate", json={"topic": topic, "max_articles": 15}
            )
    assert resp1.status_code == 200
    assert mock_llm.call_count == 1

    # Second call — cache hit → LLM must NOT be called
    with patch("main._hybrid_retrieve", return_value=list(FAKE_ARTICLES)):
        with patch("main.complete", return_value=FAKE_BRIEFING_JSON) as mock_llm2:
            resp2 = client.post(
                "/briefing/generate", json={"topic": topic, "max_articles": 15}
            )
    assert resp2.status_code == 200
    mock_llm2.assert_not_called()

    # Both responses should carry the same briefing
    assert _first_sse_payload(resp1.text) == _first_sse_payload(resp2.text)


def test_briefing_schema(app_client):
    """LLM output is forwarded as SSE and must have all required top-level keys."""
    client, _ = app_client

    with patch("main._hybrid_retrieve", return_value=list(FAKE_ARTICLES)):
        with patch("main.complete", return_value=FAKE_BRIEFING_JSON):
            resp = client.post(
                "/briefing/generate", json={"topic": "RBI policy", "max_articles": 15}
            )

    assert resp.status_code == 200
    raw = _first_sse_payload(resp.text)
    assert raw, "SSE must contain a data payload"

    briefing = json.loads(raw)
    for key in ("summary", "key_developments", "stakeholders", "open_questions", "what_to_watch"):
        assert key in briefing, f"Missing required key: {key}"

    assert isinstance(briefing["key_developments"], list)
    assert isinstance(briefing["stakeholders"], list)
    assert isinstance(briefing["open_questions"], list)
    assert isinstance(briefing["what_to_watch"], list)


def test_ask_uses_articles_only(app_client):
    """The system prompt for /briefing/ask must instruct GPT-4o to use ONLY the articles."""
    client, _ = app_client

    with patch("main._hybrid_retrieve", return_value=list(FAKE_ARTICLES)):
        with patch("main.complete", return_value="Home loan rates may rise.") as mock_llm:
            resp = client.post(
                "/briefing/ask",
                json={"topic": "RBI rates", "question": "What does this mean for home loans?"},
            )

    assert resp.status_code == 200

    # Inspect the system prompt passed to complete()
    assert mock_llm.called, "complete() should have been called"
    system_prompt = mock_llm.call_args.kwargs.get("system", "")
    assert "ONLY" in system_prompt, (
        f"System prompt must contain 'ONLY' to restrict answers to retrieved articles. "
        f"Got: {system_prompt!r}"
    )
