"""
Tests for services/agent/main.py

All external HTTP calls (feature services) and OpenAI calls are mocked.
PostgreSQL is replaced with an in-memory SQLite database for isolation.
"""

from __future__ import annotations

import json
import sys
import os
from concurrent.futures import Future
from datetime import datetime, timezone
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

# ---------------------------------------------------------------------------
# Bootstrap: point sys.path at shared/ and stub out llm_client before import
# ---------------------------------------------------------------------------

_SHARED = os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared")
sys.path.insert(0, _SHARED)

# Stub llm_client so the module can be imported without OPENAI_API_KEY
_llm_stub = MagicMock()
sys.modules.setdefault("llm_client", _llm_stub)

# ---------------------------------------------------------------------------
# Patch DATABASE_URL to use SQLite before importing main
# ---------------------------------------------------------------------------

os.environ["DATABASE_URL"] = "sqlite:///./test_agent.db"
os.environ["OPENAI_API_KEY"] = "sk-test"

import main as agent_main  # noqa: E402

from main import (  # noqa: E402
    AgentDecision,
    AgentRun,
    Base,
    app,
    engine,
    get_decision,
    process_article,
    run_agent_cycle,
    tool_generate_briefing,
    tool_generate_video,
    tool_translate,
    tool_update_arc,
    tool_update_feed,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def fresh_db():
    """Recreate all tables in SQLite before each test."""
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield
    Base.metadata.drop_all(engine)


@pytest.fixture()
def client():
    return TestClient(app)


SAMPLE_ARTICLE = {
    "article_id": "abc123def456",
    "title": "RBI raises repo rate amid inflation concerns",
    "summary": "The Reserve Bank of India increased the repo rate by 25 bps.",
    "section": "economy",
    "pub_date": datetime.now(tz=timezone.utc).isoformat(),
}

SAMPLE_DECISION = {
    "should_translate": True,
    "translate_langs": ["hi", "ta"],
    "should_update_arc": True,
    "arc_topic": "RBI",
    "should_generate_briefing": False,
    "briefing_topic": None,
    "should_generate_video": False,
    "reasoning": "Economy article mentioning RBI triggers translate and arc.",
}

# ---------------------------------------------------------------------------
# Helper: mock get_decision to return SAMPLE_DECISION
# ---------------------------------------------------------------------------


def _mock_decision(monkeypatch, decision=None):
    d = decision or SAMPLE_DECISION
    monkeypatch.setattr(agent_main, "get_decision", lambda _article: d)


def _mock_tools(monkeypatch):
    monkeypatch.setattr(agent_main, "tool_translate", lambda a, l: {"translated": True})
    monkeypatch.setattr(agent_main, "tool_update_arc", lambda a, t: {"entities": 3})
    monkeypatch.setattr(agent_main, "tool_generate_briefing", lambda t: {"briefing": t})
    monkeypatch.setattr(agent_main, "tool_generate_video", lambda a: {"job_id": "vid-1"})
    monkeypatch.setattr(agent_main, "tool_update_feed", lambda a: {"status": "available_in_feed"})


# ---------------------------------------------------------------------------
# test_health
# ---------------------------------------------------------------------------


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "agent"
    assert "last_run" in body
    assert "articles_processed_today" in body
    assert "tools_invoked_today" in body


# ---------------------------------------------------------------------------
# test_decision_schema — GPT-4o mock returns valid JSON decision
# ---------------------------------------------------------------------------


def test_decision_schema(monkeypatch):
    """get_decision parses a mocked LLM response into the expected dict shape."""
    mock_llm = sys.modules["llm_client"]
    mock_llm.complete.return_value = json.dumps(SAMPLE_DECISION)

    result = get_decision(SAMPLE_ARTICLE)

    assert isinstance(result, dict)
    assert "should_translate" in result
    assert "should_update_arc" in result
    assert "should_generate_briefing" in result
    assert "should_generate_video" in result
    assert "reasoning" in result
    assert isinstance(result["translate_langs"], list)


# ---------------------------------------------------------------------------
# test_translate_triggered
# ---------------------------------------------------------------------------


def test_translate_triggered(monkeypatch):
    """Economy section article → should_translate=True in process result."""
    # get_decision returns a decision with should_translate=True
    monkeypatch.setattr(agent_main, "get_decision", lambda _: SAMPLE_DECISION)
    _mock_tools(monkeypatch)

    result = process_article(SAMPLE_ARTICLE)

    assert "translate" in result["tools_invoked"]
    assert result["tool_results"]["translate"] == {"translated": True}


# ---------------------------------------------------------------------------
# test_arc_triggered
# ---------------------------------------------------------------------------


def test_arc_triggered(monkeypatch):
    """Article mentioning RBI → arc tool invoked."""
    monkeypatch.setattr(agent_main, "get_decision", lambda _: SAMPLE_DECISION)
    _mock_tools(monkeypatch)

    result = process_article(SAMPLE_ARTICLE)

    assert "arc" in result["tools_invoked"]
    assert result["tool_results"]["arc"] == {"entities": 3}


# ---------------------------------------------------------------------------
# test_video_not_always
# ---------------------------------------------------------------------------


def test_video_not_always(monkeypatch):
    """Video is NOT triggered unless should_generate_video is True."""
    decision_no_video = {**SAMPLE_DECISION, "should_generate_video": False}
    monkeypatch.setattr(agent_main, "get_decision", lambda _: decision_no_video)
    _mock_tools(monkeypatch)

    result = process_article(SAMPLE_ARTICLE)

    assert "video" not in result["tools_invoked"]


def test_video_triggered_when_high_importance(monkeypatch):
    """Video IS triggered when should_generate_video=True."""
    decision_with_video = {**SAMPLE_DECISION, "should_generate_video": True}
    monkeypatch.setattr(agent_main, "get_decision", lambda _: decision_with_video)
    _mock_tools(monkeypatch)

    result = process_article(SAMPLE_ARTICLE)

    assert "video" in result["tools_invoked"]
    assert result["tool_results"]["video"] == {"job_id": "vid-1"}


# ---------------------------------------------------------------------------
# test_audit_trail
# ---------------------------------------------------------------------------


def test_audit_trail(client, monkeypatch):
    """After processing an article, decision appears in GET /agent/decisions."""
    monkeypatch.setattr(agent_main, "get_decision", lambda _: SAMPLE_DECISION)
    _mock_tools(monkeypatch)

    # Process via POST /agent/process-article
    resp = client.post(
        "/agent/process-article",
        json={
            "article_id": SAMPLE_ARTICLE["article_id"],
            "title": SAMPLE_ARTICLE["title"],
            "summary": SAMPLE_ARTICLE["summary"],
            "section": SAMPLE_ARTICLE["section"],
        },
    )
    assert resp.status_code == 200

    # Check audit trail
    trail_resp = client.get("/agent/decisions?limit=10")
    assert trail_resp.status_code == 200
    decisions = trail_resp.json()["decisions"]
    assert len(decisions) >= 1
    ids = [d["article_id"] for d in decisions]
    assert SAMPLE_ARTICLE["article_id"] in ids


# ---------------------------------------------------------------------------
# test_manual_trigger
# ---------------------------------------------------------------------------


def test_manual_trigger(client, monkeypatch):
    """POST /agent/trigger returns a run summary dict."""
    # Mock the ingestion service returning no articles (empty cycle is fine)
    monkeypatch.setattr(agent_main, "run_agent_cycle", lambda: {
        "articles_processed": 0,
        "tools_invoked_total": 0,
        "decisions": [],
    })

    resp = client.post("/agent/trigger")
    assert resp.status_code == 200
    body = resp.json()
    assert "articles_processed" in body or "status" in body


# ---------------------------------------------------------------------------
# test_parallel_tools
# ---------------------------------------------------------------------------


def test_parallel_tools(monkeypatch):
    """Multiple tools execute concurrently via ThreadPoolExecutor."""
    call_log: list[str] = []

    def track_translate(a, l):
        call_log.append("translate")
        return {"translated": True}

    def track_arc(a, t):
        call_log.append("arc")
        return {"entities": 1}

    def track_feed(a):
        call_log.append("feed")
        return {"status": "available_in_feed"}

    decision_all = {
        **SAMPLE_DECISION,
        "should_generate_briefing": False,
        "should_generate_video": False,
    }
    monkeypatch.setattr(agent_main, "get_decision", lambda _: decision_all)
    monkeypatch.setattr(agent_main, "tool_translate", track_translate)
    monkeypatch.setattr(agent_main, "tool_update_arc", track_arc)
    monkeypatch.setattr(agent_main, "tool_update_feed", track_feed)

    result = process_article(SAMPLE_ARTICLE)

    # All three tools should have been called
    assert "translate" in call_log
    assert "arc" in call_log
    assert "feed" in call_log
    # All should appear in tools_invoked
    assert set(["translate", "arc", "feed"]).issubset(set(result["tools_invoked"]))


# ---------------------------------------------------------------------------
# test_decision_logged_on_failure
# ---------------------------------------------------------------------------


def test_decision_logged_on_failure(client, monkeypatch):
    """If a tool fails, the decision is still logged with error and status=partial/failed."""
    monkeypatch.setattr(agent_main, "get_decision", lambda _: SAMPLE_DECISION)
    # Arc tool raises an exception
    monkeypatch.setattr(agent_main, "tool_update_arc", lambda a: (_ for _ in ()).throw(RuntimeError("arc service down")))
    monkeypatch.setattr(agent_main, "tool_translate", lambda a, l: {"translated": True})
    monkeypatch.setattr(agent_main, "tool_update_feed", lambda a: {"status": "available_in_feed"})

    result = process_article(SAMPLE_ARTICLE)

    # Status should indicate partial or failed (not completed)
    assert result["status"] in ("partial", "failed")
    # The failed tool result should contain an error key
    assert "error" in result["tool_results"].get("arc", {})

    # Decision still persisted — check via API
    resp = client.get(f"/agent/decisions/{SAMPLE_ARTICLE['article_id']}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["article_id"] == SAMPLE_ARTICLE["article_id"]
    assert body["status"] in ("partial", "failed")


# ---------------------------------------------------------------------------
# Additional: test_agent_stats and test_agent_runs
# ---------------------------------------------------------------------------


def test_agent_stats(client, monkeypatch):
    """GET /agent/stats returns expected shape."""
    monkeypatch.setattr(agent_main, "get_decision", lambda _: SAMPLE_DECISION)
    _mock_tools(monkeypatch)
    # Process one article to have data
    client.post(
        "/agent/process-article",
        json={
            "article_id": "stats-test-001",
            "title": "Stats Test Article",
            "summary": "Economy policy test",
            "section": "economy",
        },
    )

    resp = client.get("/agent/stats")
    assert resp.status_code == 200
    body = resp.json()
    assert "total_articles_processed" in body
    assert "total_tools_invoked" in body
    assert "tools_breakdown" in body
    assert "avg_tools_per_article" in body


def test_agent_runs_endpoint(client):
    """GET /agent/runs returns a list."""
    resp = client.get("/agent/runs?limit=5")
    assert resp.status_code == 200
    assert "runs" in resp.json()


def test_process_article_endpoint(client, monkeypatch):
    """POST /agent/process-article returns decision dict."""
    monkeypatch.setattr(agent_main, "get_decision", lambda _: SAMPLE_DECISION)
    _mock_tools(monkeypatch)

    resp = client.post(
        "/agent/process-article",
        json={
            "article_id": "ep-test-001",
            "title": "Market rally as Nifty hits all time high",
            "summary": "Nifty 50 surged 200 points on strong FII inflows.",
            "section": "markets",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["article_id"] == "ep-test-001"
    assert "tools_invoked" in body
    assert "reasoning" in body
    assert body["status"] in ("completed", "partial", "failed")
