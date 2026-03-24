"""
Unit tests for the ingestion-pipeline service.

All external calls (feedparser, OpenAI, Qdrant, Redis, PostgreSQL)
are mocked so no real network/infra is needed.
"""

from __future__ import annotations

import hashlib
import sys
import os
import time
import types
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch, call

import pytest

# ---------------------------------------------------------------------------
# Stub heavy shared-library deps before importing main
# ---------------------------------------------------------------------------

def _make_stub(name: str) -> types.ModuleType:
    mod = types.ModuleType(name)
    sys.modules[name] = mod
    return mod


# openai stub
openai_mod = _make_stub("openai")
openai_mod.OpenAI = MagicMock()

# qdrant_client stub
qc_mod = _make_stub("qdrant_client")
qc_models = _make_stub("qdrant_client.models")
qc_models.Distance = MagicMock()
qc_models.PointStruct = MagicMock()
qc_models.VectorParams = MagicMock()
qc_models.Filter = MagicMock()
qc_models.FieldCondition = MagicMock()
qc_models.MatchValue = MagicMock()
qc_mod.QdrantClient = MagicMock()

# kafka_client stub
_make_stub("kafka_client")

# llm_client stub — expose embed()
llm_stub = _make_stub("llm_client")
llm_stub.embed = MagicMock(return_value=[0.1] * 1536)

# vector_store stub
vs_stub = _make_stub("vector_store")
vs_stub.ensure_collection = MagicMock()
vs_stub.upsert = MagicMock()
vs_stub.get_client = MagicMock()

# apscheduler stubs
aps_mod = _make_stub("apscheduler")
aps_schedulers = _make_stub("apscheduler.schedulers")
aps_bg = _make_stub("apscheduler.schedulers.background")
aps_bg.BackgroundScheduler = MagicMock()

# redis stub
redis_mod = _make_stub("redis")
redis_mod.Redis = MagicMock()
redis_mod.from_url = MagicMock()

# feedparser stub
feedparser_stub = _make_stub("feedparser")
feedparser_stub.parse = MagicMock(return_value=MagicMock(entries=[]))


# sqlalchemy stubs (keep real ones if already imported, else stub)
if "sqlalchemy" not in sys.modules:
    sa_stub = _make_stub("sqlalchemy")
    sa_stub.create_engine = MagicMock(return_value=MagicMock())
    sa_stub.Column = MagicMock()
    sa_stub.Integer = MagicMock()
    sa_stub.String = MagicMock()
    sa_stub.Text = MagicMock()
    sa_stub.DateTime = MagicMock()
    sa_stub.text = MagicMock()
    sa_orm = _make_stub("sqlalchemy.orm")
    sa_orm.DeclarativeBase = object
    sa_orm.Session = MagicMock()

# psycopg2 stub
_make_stub("psycopg2")

# dotenv stub
dotenv_stub = _make_stub("dotenv")
dotenv_stub.load_dotenv = MagicMock()

# requests stub
_make_stub("requests")

# ---------------------------------------------------------------------------
# Now set env vars and import main
# ---------------------------------------------------------------------------

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

# Patch create_engine before importing main so the engine is a mock
with patch("sqlalchemy.create_engine", MagicMock(return_value=MagicMock())):
    # Add shared path
    shared_path = os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared")
    if shared_path not in sys.path:
        sys.path.insert(0, shared_path)

    import importlib
    import main as m


# ---------------------------------------------------------------------------
# FastAPI test client
# ---------------------------------------------------------------------------

from fastapi.testclient import TestClient

# Build a plain app without lifespan for testing
from fastapi import FastAPI
test_app = FastAPI()
test_app.include_router(m.app.router) if hasattr(m.app, "router") else None

# Use the real app but skip lifespan
client = TestClient(m.app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_entry(
    link: str = "https://example.com/article/1",
    title: str = "Test Article",
    summary: str = "<p>Some <b>summary</b> text</p>",
    published_parsed: tuple | None = None,
) -> MagicMock:
    entry = MagicMock()
    entry.link = link
    entry.title = title
    entry.summary = summary
    entry.get = lambda key, default=None: {
        "link": link,
        "title": title,
        "summary": summary,
        "published_parsed": published_parsed or time.gmtime(),
    }.get(key, default)
    entry.published_parsed = published_parsed or time.gmtime()
    return entry


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_health():
    """GET /health returns 200 with expected keys."""
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["service"] == "ingestion"
    assert "last_run" in data
    assert "articles_total" in data


def test_article_id_deterministic():
    """Same URL always produces the same UUID article_id."""
    url = "https://economictimes.indiatimes.com/some-article/articleshow/12345.cms"
    id1 = m.make_article_id(url)
    id2 = m.make_article_id(url)
    assert id1 == id2
    assert len(id1) == 36  # UUID format: 8-4-4-4-12
    # Verify it is a valid UUID derived from sha256 bytes
    import uuid
    expected = str(uuid.UUID(bytes=hashlib.sha256(url.encode()).digest()[:16]))
    assert id1 == expected


def test_article_id_different_urls():
    """Different URLs produce different article_ids."""
    id1 = m.make_article_id("https://example.com/a")
    id2 = m.make_article_id("https://example.com/b")
    assert id1 != id2


def test_html_stripping():
    """HTML tags are removed from summary."""
    raw = "<p>Hello <b>world</b> &amp; <i>news</i></p>"
    clean = m.strip_html(raw)
    assert "<" not in clean
    assert ">" not in clean
    assert "Hello" in clean
    assert "world" in clean
    assert "news" in clean


def test_html_stripping_plain_text():
    """Plain text passes through strip_html unchanged (except whitespace)."""
    raw = "Just plain text here."
    assert m.strip_html(raw).strip() == raw


def test_dedup_skips_existing():
    """Article already in Redis SET → embed is NOT called again."""
    llm_stub.embed.reset_mock()
    vs_stub.upsert.reset_mock()

    article_id = m.make_article_id("https://example.com/dup")

    with patch.object(m, "is_already_ingested", return_value=True) as mock_check, \
         patch.object(m, "embed_and_store") as mock_embed:
        # Build a minimal article dict
        article = {
            "article_id": article_id,
            "title": "Dup Article",
            "summary": "Already seen",
            "url": "https://example.com/dup",
            "section": "tech",
            "pub_date": "2026-03-23T00:00:00+00:00",
            "pub_ts": 1742688000.0,
            "source": "Economic Times",
        }
        # Simulate one article from one feed
        with patch.object(m, "parse_feed", return_value=[article]), \
             patch.object(m, "FEEDS", {"tech": "http://fake-feed"}), \
             patch("main.Session") as mock_session:
            mock_session.return_value.__enter__ = MagicMock(return_value=MagicMock())
            mock_session.return_value.__exit__ = MagicMock(return_value=False)
            stats = m.run_ingestion()

        assert mock_embed.call_count == 0
        assert stats["articles_skipped"] == 1
        assert stats["articles_new"] == 0


def test_new_article_is_embedded():
    """New article (not in Redis) → embed_and_store is called once."""
    article_id = m.make_article_id("https://example.com/new-article")
    article = {
        "article_id": article_id,
        "title": "Brand New Article",
        "summary": "Fresh content",
        "url": "https://example.com/new-article",
        "section": "markets",
        "pub_date": "2026-03-23T00:00:00+00:00",
        "pub_ts": 1742688000.0,
        "source": "Economic Times",
    }

    with patch.object(m, "is_already_ingested", return_value=False), \
         patch.object(m, "embed_and_store") as mock_embed, \
         patch.object(m, "mark_ingested"), \
         patch.object(m, "parse_feed", return_value=[article]), \
         patch.object(m, "FEEDS", {"markets": "http://fake-feed"}), \
         patch("main.Session") as mock_session:
        mock_session.return_value.__enter__ = MagicMock(return_value=MagicMock())
        mock_session.return_value.__exit__ = MagicMock(return_value=False)
        stats = m.run_ingestion()

    mock_embed.assert_called_once_with(article)
    assert stats["articles_new"] == 1
    assert stats["articles_skipped"] == 0


def test_manual_trigger():
    """POST /ingest/trigger returns 200."""
    with patch("main.run_ingestion"), \
         patch("threading.Thread") as mock_thread:
        mock_thread.return_value.start = MagicMock()
        resp = client.post("/ingest/trigger")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "triggered"


def test_parse_rss_entry():
    """Mock feedparser entry → correct article dict."""
    url = "https://economictimes.indiatimes.com/article/12345.cms"
    title = "Sensex Jumps 500 Points"
    raw_summary = "<p>Markets rallied <b>strongly</b> today.</p>"
    entry = _make_entry(link=url, title=title, summary=raw_summary)

    parsed_feed = MagicMock()
    parsed_feed.entries = [entry]

    with patch.object(feedparser_stub, "parse", return_value=parsed_feed):
        articles = m.parse_feed("markets", "http://fake-url")

    assert len(articles) == 1
    a = articles[0]
    assert a["article_id"] == m.make_article_id(url)
    assert a["title"] == title
    assert "<" not in a["summary"]
    assert "rallied" in a["summary"]
    assert "strongly" in a["summary"]
    assert a["url"] == url
    assert a["section"] == "markets"
    assert a["source"] == "Economic Times"
    assert isinstance(a["pub_date"], str)
    assert isinstance(a["pub_ts"], float)


def test_parse_rss_entry_skips_no_link():
    """Entries without a link are skipped."""
    entry = MagicMock()
    entry.get = lambda key, default=None: {"link": "", "title": "No URL"}.get(key, default)

    parsed_feed = MagicMock()
    parsed_feed.entries = [entry]

    with patch.object(feedparser_stub, "parse", return_value=parsed_feed):
        articles = m.parse_feed("tech", "http://fake-url")

    assert articles == []


def test_parse_pub_date_fallback():
    """When published_parsed is missing, falls back to current time."""
    entry = MagicMock(spec=[])  # no published_parsed attribute
    entry.get = lambda key, default=None: None

    iso_str, ts = m.parse_pub_date(entry)
    assert isinstance(iso_str, str)
    assert isinstance(ts, float)
    assert ts > 0


def test_ingestion_stats_db_error():
    """GET /ingest/stats returns 500 when DB is unavailable."""
    with patch("main.Session", side_effect=Exception("DB down")):
        resp = client.get("/ingest/stats")
    assert resp.status_code == 500


def test_list_articles_qdrant_error():
    """GET /ingest/articles returns 500 when Qdrant is unavailable."""
    with patch("main.vs_stub", create=True), \
         patch.dict(sys.modules, {"vector_store": MagicMock(get_client=MagicMock(side_effect=Exception("qdrant down")))}):
        resp = client.get("/ingest/articles")
    assert resp.status_code == 500
