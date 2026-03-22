"""
Tests for feature-arc: NER pipeline, alias resolution, sentiment, arc endpoints.

All external calls (OpenAI, Neo4j, PostgreSQL, spaCy) are mocked.
"""

import json
import os
import sys
from unittest.mock import MagicMock, Mock, patch

import pytest

# ── Environment must be set before importing main ──────────────────────────────
os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg2://test:test@localhost/test")
os.environ.setdefault("NEO4J_URI", "bolt://localhost:7687")

# Add service root so `import main` resolves correctly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402
from main import (  # noqa: E402
    DEFAULT_ALIASES,
    compute_sentiment_trend,
    extract_entities,
    resolve_alias,
)
from fastapi.testclient import TestClient  # noqa: E402


# ── Fixtures ───────────────────────────────────────────────────────────────────


@pytest.fixture
def client():
    """TestClient with startup side-effects (DB init, alias file) patched out."""
    with (
        patch.object(main, "init_db", return_value=None),
        patch.object(main, "ensure_alias_file", return_value=None),
    ):
        with TestClient(main.app) as c:
            yield c


# ── Helper ─────────────────────────────────────────────────────────────────────


def _timeline(scores: list[float]) -> list[dict]:
    return [
        {
            "article_id": f"a{i}",
            "sentiment_score": s,
            "label": "neutral",
            "pub_date": None,
        }
        for i, s in enumerate(scores)
    ]


# ── Tests ──────────────────────────────────────────────────────────────────────


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["service"] == "feature-arc"


def test_alias_resolution():
    # Known alias resolves to canonical name
    with patch.object(main, "load_aliases", return_value=DEFAULT_ALIASES):
        assert resolve_alias("RBI") == "Reserve Bank of India"
        assert resolve_alias("PM Modi") == "Narendra Modi"

    # Unknown alias is returned unchanged
    with patch.object(main, "load_aliases", return_value={}):
        assert resolve_alias("UNKNOWN_ENTITY_XYZ") == "UNKNOWN_ENTITY_XYZ"


def test_ner_extracts_entities():
    """NER pipeline extracts ORG and PERSON entities and applies alias resolution."""
    # Build mock tokens for sentence-index mapping
    tok0 = MagicMock()
    tok0.i = 0
    tok1 = MagicMock()
    tok1.i = 1
    tok5 = MagicMock()
    tok5.i = 5

    # Two mock sentences
    sent0 = MagicMock()
    sent0.__iter__ = Mock(return_value=iter([tok0, tok1]))
    sent1 = MagicMock()
    sent1.__iter__ = Mock(return_value=iter([tok5]))

    # Mock entities returned by spaCy
    ent_org = MagicMock()
    ent_org.text = "Reserve Bank of India"
    ent_org.label_ = "ORG"
    ent_org.start = 0  # maps to sent 0

    ent_person = MagicMock()
    ent_person.text = "PM Modi"  # alias → Narendra Modi
    ent_person.label_ = "PERSON"
    ent_person.start = 5  # maps to sent 1

    # Mock doc
    mock_doc = MagicMock()
    mock_doc.ents = [ent_org, ent_person]
    mock_doc.sents = [sent0, sent1]

    # Mock nlp callable: get_nlp() returns mock_nlp, mock_nlp(text) returns mock_doc
    mock_nlp = MagicMock(return_value=mock_doc)

    with (
        patch.object(main, "get_nlp", return_value=mock_nlp),
        patch.object(main, "load_aliases", return_value=DEFAULT_ALIASES),
    ):
        results = extract_entities(
            "Reserve Bank of India raised rates. PM Modi spoke."
        )

    assert len(results) == 2
    names = [r[0] for r in results]
    types = [r[1] for r in results]

    assert "Reserve Bank of India" in names  # no alias needed
    assert "Narendra Modi" in names  # PM Modi → Narendra Modi via alias
    assert "ORG" in types
    assert "PERSON" in types

    # Sentence indices
    sent_indices = {r[0]: r[2] for r in results}
    assert sent_indices["Reserve Bank of India"] == 0
    assert sent_indices["Narendra Modi"] == 1


def test_sentiment_schema():
    """score_sentiment parses GPT-4o-mini response and returns correct schema."""
    mock_response = json.dumps(
        {
            "score": 0.75,
            "label": "positive",
            "reason": "The article describes strong economic growth and falling inflation.",
        }
    )
    with patch("main.complete", return_value=mock_response):
        result = main.score_sentiment("India GDP grows at record pace in Q1.")

    assert "score" in result
    assert "label" in result
    assert "reason" in result
    assert isinstance(result["score"], float)
    assert 0.0 <= result["score"] <= 1.0
    assert result["label"] in {"positive", "neutral", "negative"}


def test_sentiment_trend_improving():
    timeline = _timeline([0.2, 0.3, 0.25, 0.65, 0.75, 0.80])
    assert compute_sentiment_trend(timeline) == "improving"


def test_sentiment_trend_declining():
    timeline = _timeline([0.75, 0.80, 0.70, 0.30, 0.25, 0.20])
    assert compute_sentiment_trend(timeline) == "declining"


def test_sentiment_trend_stable():
    timeline = _timeline([0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
    assert compute_sentiment_trend(timeline) == "stable"


def test_arc_response_schema(client):
    """GET /arc/{topic} returns predictions, contrarian_view, and watch_for."""
    mock_timeline = _timeline([0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
    mock_entities = [
        {"name": "Narendra Modi", "type": "PERSON", "connections": 7},
        {"name": "Nirmala Sitharaman", "type": "PERSON", "connections": 4},
        {"name": "Reserve Bank of India", "type": "ORG", "connections": 10},
    ]
    mock_prediction_json = json.dumps(
        {
            "predictions": [
                "Rate cut likely in Q2 2026",
                "Inflation expected to ease below 4%",
                "Bond yields likely to soften by 25 bps",
            ],
            "contrarian_view": "Markets may overshoot on rate-cut optimism.",
            "watch_for": "CPI print for April 2026.",
        }
    )

    with (
        patch.object(main, "get_sentiment_timeline", return_value=mock_timeline),
        patch.object(main, "get_topic_entities", return_value=mock_entities),
        patch("main.complete", return_value=mock_prediction_json),
    ):
        resp = client.get("/arc/RBI")

    assert resp.status_code == 200
    data = resp.json()

    # Required top-level keys
    assert "predictions" in data
    assert "contrarian_view" in data
    assert "watch_for" in data
    assert "timeline" in data
    assert "sentiment_trend" in data
    assert "key_entities" in data

    # Predictions must be a list of 3 strings
    assert isinstance(data["predictions"], list)
    assert len(data["predictions"]) == 3
    assert all(isinstance(p, str) for p in data["predictions"])

    assert isinstance(data["contrarian_view"], str)
    assert len(data["contrarian_view"]) > 0

    assert isinstance(data["watch_for"], str)
    assert len(data["watch_for"]) > 0

    assert data["sentiment_trend"] in {"improving", "declining", "stable"}
    assert data["article_count"] == 6
