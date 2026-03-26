"""
RSS ingestion service for Economic Times articles.

Polls 7 ET RSS feeds every 30 minutes, embeds articles via OpenAI
text-embedding-3-small, and stores vectors in Qdrant.

Endpoints:
  GET  /health                       → service health + last run info
  POST /ingest/trigger               → manually trigger ingestion now
  GET  /ingest/stats                 → last 10 ingestion runs (from PG)
  GET  /ingest/articles?limit=&section= → recently ingested articles
  GET  /ingest/count                 → total articles in Qdrant
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))

import feedparser
import redis
import requests
from apscheduler.schedulers.background import BackgroundScheduler
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from sqlalchemy import (
    Column,
    DateTime,
    Integer,
    String,
    Text,
    create_engine,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Session

load_dotenv()

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

FEEDS: dict[str, str] = {
    "markets":  "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
    "economy":  "https://economictimes.indiatimes.com/economy/rssfeeds/1373380680.cms",
    "tech":     "https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms",
    "startups": "https://economictimes.indiatimes.com/small-biz/startups/rssfeeds/9701786.cms",
    "news":     "https://economictimes.indiatimes.com/news/rssfeeds/1715249553.cms",
    "finance":  "https://economictimes.indiatimes.com/wealth/rssfeeds/837555174.cms",
    "industry": "https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms",
}

COLLECTION = "articles"
REDIS_KEY = "ingested_articles"

POSTGRES_URL = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/et_news"
)
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

# ---------------------------------------------------------------------------
# Database setup
# ---------------------------------------------------------------------------

engine = create_engine(POSTGRES_URL, pool_pre_ping=True)


class Base(DeclarativeBase):
    pass


class IngestionRun(Base):
    __tablename__ = "ingestion_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    started_at = Column(DateTime(timezone=True), nullable=False)
    completed_at = Column(DateTime(timezone=True))
    feeds_polled = Column(Integer, default=0)
    articles_found = Column(Integer, default=0)
    articles_new = Column(Integer, default=0)
    articles_skipped = Column(Integer, default=0)
    errors = Column(Text, default="")


def init_db() -> None:
    try:
        Base.metadata.create_all(engine)
        log.info("DB table ingestion_runs ready")
    except Exception as exc:
        log.warning("Could not create DB table: %s", exc)


# ---------------------------------------------------------------------------
# Redis client (lazy)
# ---------------------------------------------------------------------------

_redis: redis.Redis | None = None


def get_redis() -> redis.Redis:
    global _redis
    if _redis is None:
        _redis = redis.from_url(REDIS_URL, decode_responses=True)
    return _redis


# ---------------------------------------------------------------------------
# State shared with endpoints
# ---------------------------------------------------------------------------

_last_run_ts: float | None = None
_articles_total: int = 0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_article_id(url: str) -> str:
    hash_bytes = hashlib.sha256(url.encode()).digest()[:16]
    return str(uuid.UUID(bytes=hash_bytes))


def strip_html(raw: str) -> str:
    return BeautifulSoup(raw, "html.parser").get_text(separator=" ").strip()


def parse_pub_date(entry) -> tuple[str, float]:
    """Return (ISO string, unix timestamp) from a feedparser entry."""
    if entry.get("published_parsed"):
        ts = time.mktime(entry.published_parsed)
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        return dt.isoformat(), ts
    now = datetime.now(tz=timezone.utc)
    return now.isoformat(), now.timestamp()


def is_already_ingested(article_id: str) -> bool:
    """Check Redis (fast cache) then Qdrant (persistent) for dedup.

    Redis is volatile — cleared on restart — so Qdrant is the source of truth.
    Redis is only used to avoid redundant Qdrant lookups within a session.
    On any error we return False so the article is retried rather than skipped.
    """
    try:
        # Fast path: Redis in-memory cache
        if get_redis().sismember(REDIS_KEY, article_id):
            return True
    except Exception:
        pass

    try:
        # Persistent path: Qdrant
        import vector_store as vs
        results = vs.get_client().retrieve(
            collection_name=COLLECTION,
            ids=[article_id],
            with_payload=False,
            with_vectors=False,
        )
        if results:
            # Backfill Redis cache so future checks stay fast
            try:
                get_redis().sadd(REDIS_KEY, article_id)
            except Exception:
                pass
            return True
    except Exception:
        pass

    return False


def mark_ingested(article_id: str) -> None:
    try:
        get_redis().sadd(REDIS_KEY, article_id)
    except Exception:
        pass


def embed_and_store(article: dict) -> None:
    """Embed article text and upsert to Qdrant."""
    import vector_store
    from llm_client import embed

    text_to_embed = f"{article['title']}. {article['summary']}"
    vector = embed(text_to_embed)

    vector_store.upsert(
        collection=COLLECTION,
        vector=vector,
        payload={
            "article_id": article["article_id"],
            "title": article["title"],
            "summary": article["summary"],
            "url": article["url"],
            "section": article["section"],
            "pub_date": article["pub_date"],
            "pub_ts": article["pub_ts"],
            "source": article["source"],
        },
        point_id=article["article_id"],
    )


# ---------------------------------------------------------------------------
# Core ingestion
# ---------------------------------------------------------------------------


def parse_feed(section: str, feed_url: str) -> list[dict]:
    """Parse one RSS feed, return list of article dicts."""
    articles: list[dict] = []
    try:
        parsed = feedparser.parse(feed_url)
        for entry in parsed.entries:
            url = entry.get("link", "")
            if not url:
                continue
            raw_summary = (
                entry.get("summary")
                or entry.get("description")
                or (entry.get("content", [{}])[0].get("value") if entry.get("content") else None)
                or ""
            )
            clean_summary = strip_html(raw_summary) if raw_summary else ""
            if len(clean_summary) < 20:
                clean_summary = ""
            pub_date, pub_ts = parse_pub_date(entry)
            articles.append(
                {
                    "article_id": make_article_id(url),
                    "title": entry.get("title", "").strip(),
                    "summary": clean_summary,
                    "url": url,
                    "section": section,
                    "pub_date": pub_date,
                    "pub_ts": pub_ts,
                    "source": "Economic Times",
                }
            )
    except Exception as exc:
        log.error("Error parsing feed %s: %s", feed_url, exc)
    return articles


def run_ingestion() -> dict:
    """
    Main ingestion job. Called by scheduler and /ingest/trigger.
    Returns a summary dict.
    """
    global _last_run_ts, _articles_total

    started_at = datetime.now(tz=timezone.utc)
    _last_run_ts = started_at.timestamp()

    stats = {
        "feeds_polled": 0,
        "articles_found": 0,
        "articles_new": 0,
        "articles_skipped": 0,
        "errors": [],
    }

    log.info("Ingestion run started at %s", started_at.isoformat())

    # Ensure Qdrant collection exists
    try:
        import vector_store
        vector_store.ensure_collection(COLLECTION)
    except Exception as exc:
        log.warning("Could not ensure Qdrant collection: %s", exc)

    for section, feed_url in FEEDS.items():
        stats["feeds_polled"] += 1
        articles = parse_feed(section, feed_url)
        stats["articles_found"] += len(articles)

        for article in articles:
            aid = article["article_id"]
            if is_already_ingested(aid):
                stats["articles_skipped"] += 1
                continue

            try:
                embed_and_store(article)
                mark_ingested(aid)
                stats["articles_new"] += 1
                log.info("Ingested %s: %s", section, article["title"][:60])
            except Exception as exc:
                err = f"{aid}: {exc}"
                stats["errors"].append(err)
                log.error("Failed to ingest article %s: %s", aid, exc)

    completed_at = datetime.now(tz=timezone.utc)
    _articles_total += stats["articles_new"]

    # Log run to PostgreSQL
    try:
        with Session(engine) as session:
            run = IngestionRun(
                started_at=started_at,
                completed_at=completed_at,
                feeds_polled=stats["feeds_polled"],
                articles_found=stats["articles_found"],
                articles_new=stats["articles_new"],
                articles_skipped=stats["articles_skipped"],
                errors="; ".join(stats["errors"]),
            )
            session.add(run)
            session.commit()
    except Exception as exc:
        log.warning("Could not log run to DB: %s", exc)

    log.info(
        "Ingestion complete: found=%d new=%d skipped=%d errors=%d",
        stats["articles_found"],
        stats["articles_new"],
        stats["articles_skipped"],
        len(stats["errors"]),
    )
    return stats


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

scheduler = BackgroundScheduler()


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler.add_job(run_ingestion, "interval", minutes=30, id="rss_ingestion")
    scheduler.start()
    log.info("Scheduler started — first run triggering now")
    # Run immediately in background thread so startup doesn't block
    import threading
    threading.Thread(target=run_ingestion, daemon=True).start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="ET Ingestion Pipeline", version="1.0.0", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "ingestion",
        "last_run": _last_run_ts,
        "articles_total": _articles_total,
    }


@app.post("/ingest/trigger")
def trigger_ingestion():
    import threading
    thread = threading.Thread(target=run_ingestion, daemon=True)
    thread.start()
    return {"status": "triggered", "message": "Ingestion started in background"}


@app.get("/ingest/stats")
def ingestion_stats():
    try:
        with Session(engine) as session:
            runs = (
                session.execute(
                    text(
                        "SELECT id, started_at, completed_at, feeds_polled, "
                        "articles_found, articles_new, articles_skipped, errors "
                        "FROM ingestion_runs ORDER BY id DESC LIMIT 10"
                    )
                )
                .mappings()
                .all()
            )
            return {"runs": [dict(r) for r in runs]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/ingest/count")
def article_count():
    """Return total number of vectors stored in Qdrant."""
    try:
        import vector_store as vs
        info = vs.get_client().get_collection(COLLECTION)
        return {"total_articles": info.points_count}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/ingest/articles")
def list_articles(
    limit: int = Query(100, ge=1, le=500),
    section: Optional[str] = Query(None),
):
    try:
        import vector_store as vs

        client = vs.get_client()
        scroll_filter = None
        if section:
            from qdrant_client.models import Filter, FieldCondition, MatchValue
            scroll_filter = Filter(
                must=[FieldCondition(key="section", match=MatchValue(value=section))]
            )

        results, _ = client.scroll(
            collection_name=COLLECTION,
            scroll_filter=scroll_filter,
            limit=limit,
            with_payload=True,
            with_vectors=False,
        )
        return {"articles": [r.payload for r in results]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8006, reload=False)
