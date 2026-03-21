"""
Feature Feed — Personalisation Service

Ranks articles for a user based on:
1. Semantic similarity to a per-user interest vector (EMA model, stored in Redis)
2. Recency decay
3. Topic diversity penalty

Endpoints:
  GET  /health
  POST /onboard
  GET  /feed/{user_id}
  POST /engage
"""

from __future__ import annotations

import math
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))

from dotenv import load_dotenv

load_dotenv()

import numpy as np
import redis as redis_lib
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, field_validator
from typing import Literal, Union

import vector_store
from llm_client import embed
from qdrant_client.models import Distance, PointStruct, VectorParams

app = FastAPI(title="Feature: Feed", version="1.0.0")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VECTOR_DIM = 1536
EMA_ALPHA = 0.15

ENGAGEMENT_WEIGHTS: dict[str, float] = {
    "opened": 0.3,
    "scroll_50": 0.5,
    "scroll_100": 0.8,
    "shared": 1.0,
    "skipped": -0.2,
}

ROLE_SEEDS: dict[str, list[str]] = {
    "founder": [
        "startup fundraising venture capital",
        "product market fit growth strategy",
        "entrepreneurship business scaling India",
    ],
    "investor": [
        "equity markets stock analysis portfolio",
        "mutual funds FII DII flows valuation",
        "private equity venture capital returns",
    ],
    "student": [
        "economics finance fundamentals learning",
        "stock market basics investment education",
        "career opportunities finance banking sector",
    ],
    "analyst": [
        "financial modeling valuation DCF analysis",
        "macroeconomic indicators GDP inflation data",
        "sector research equity research report",
    ],
}

SEED_ARTICLES: list[dict] = [
    {"title": "RBI repo rate decision March 2026", "topic": "monetary_policy", "section": "economy"},
    {"title": "SEBI mutual fund regulations tightened", "topic": "regulation", "section": "markets"},
    {"title": "Infosys Q4 results beat estimates", "topic": "earnings", "section": "tech"},
    {"title": "India startup funding drops 30 percent", "topic": "startup", "section": "tech"},
    {"title": "Union Budget 2026 key highlights", "topic": "fiscal_policy", "section": "economy"},
    {"title": "Nifty 50 breaks 25000 resistance", "topic": "markets", "section": "markets"},
    {"title": "Gold vs equity returns comparison 2026", "topic": "investment", "section": "markets"},
    {"title": "FII DII flows March 2026 analysis", "topic": "flows", "section": "markets"},
    {"title": "India GDP growth forecast revised upward", "topic": "macroeconomics", "section": "economy"},
    {"title": "Banking sector NPA levels at decade low", "topic": "banking", "section": "banking"},
]

# ---------------------------------------------------------------------------
# Redis helpers
# ---------------------------------------------------------------------------


def get_redis() -> redis_lib.Redis:
    return redis_lib.Redis(
        host=os.environ.get("REDIS_HOST", "localhost"),
        port=int(os.environ.get("REDIS_PORT", 6379)),
        db=0,
        decode_responses=False,
    )


def _load_user_vec(user_id: str) -> np.ndarray | None:
    r = get_redis()
    raw = r.get(f"uvec:{user_id}")
    if raw is None:
        return None
    return np.frombuffer(raw, dtype=np.float32).copy()


def _save_user_vec(user_id: str, vec: np.ndarray) -> None:
    r = get_redis()
    r.set(f"uvec:{user_id}", vec.astype(np.float32).tobytes())


# ---------------------------------------------------------------------------
# Scoring helpers
# ---------------------------------------------------------------------------


def _recency_score(pub_ts: float) -> float:
    """Exponential decay: score = exp(-age_hours / 24)."""
    age_hours = (time.time() - pub_ts) / 3600.0
    return math.exp(-age_hours / 24.0)


# ---------------------------------------------------------------------------
# Startup: seed Qdrant
# ---------------------------------------------------------------------------


def _seed_qdrant() -> None:
    client = vector_store.get_client()

    # Always drop and recreate so stale string-ID points from previous runs are gone
    existing = [c.name for c in client.get_collections().collections]
    if "articles" in existing:
        client.delete_collection("articles")
    client.create_collection(
        collection_name="articles",
        vectors_config=VectorParams(size=VECTOR_DIM, distance=Distance.COSINE),
    )

    now = time.time()
    n = len(SEED_ARTICLES)
    points: list[PointStruct] = []
    for i, article in enumerate(SEED_ARTICLES):
        # Space pub_ts evenly across last 72 hours so recency scoring is testable
        age_hours = (i / max(n - 1, 1)) * 72.0
        pub_ts = now - age_hours * 3600.0
        payload = {
            **article,
            "pub_ts": pub_ts,
            "article_id": i + 1,
        }
        vec = embed(article["title"])
        # Use native int IDs (1-10) so qdrant.retrieve(ids=[1]) matches exactly
        points.append(PointStruct(id=i + 1, vector=vec, payload=payload))

    client.upsert(collection_name="articles", points=points)


@app.on_event("startup")
async def startup() -> None:
    _seed_qdrant()


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class OnboardRequest(BaseModel):
    user_id: str
    role: Literal["founder", "investor", "student", "analyst"]
    sectors: list[str] = []
    tickers: list[str] = []


class EngageRequest(BaseModel):
    user_id: str
    article_id: Union[int, str]
    signal: Literal["opened", "scroll_50", "scroll_100", "shared", "skipped"]

    @field_validator("article_id", mode="before")
    @classmethod
    def coerce_article_id(cls, v: Union[int, str]) -> Union[int, str]:
        if isinstance(v, str) and v.isdigit():
            return int(v)
        return v


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "feed"}


@app.post("/onboard")
async def onboard(req: OnboardRequest) -> dict:
    """
    Cold-start onboarding: build an initial user interest vector from role seeds
    plus optional sector/ticker context, then persist to Redis.
    """
    seed_phrases = list(ROLE_SEEDS[req.role])

    if req.sectors:
        seed_phrases.append(" ".join(req.sectors) + " sector news India")
    if req.tickers:
        seed_phrases.append(" ".join(req.tickers) + " stock analysis")

    vecs = [np.array(embed(phrase), dtype=np.float32) for phrase in seed_phrases]
    user_vec = np.mean(vecs, axis=0)

    _save_user_vec(req.user_id, user_vec)
    return {"status": "ok", "user_id": req.user_id, "vector_dim": int(user_vec.shape[0])}


@app.get("/feed/{user_id}")
async def get_feed(user_id: str) -> dict:
    """
    Return top-20 ranked articles for a user.
    Rerank formula: score = 0.6*cosine_sim + 0.3*recency_score - 0.1*diversity_penalty
    """
    user_vec = _load_user_vec(user_id)
    if user_vec is None:
        raise HTTPException(status_code=404, detail="User not found. Call /onboard first.")

    results = vector_store.search("articles", user_vec.tolist(), limit=200)

    now = time.time()
    for item in results:
        pub_ts = item.get("pub_ts", now)
        recency = _recency_score(pub_ts)
        item["_base_score"] = 0.6 * item["score"] + 0.3 * recency

    # Sort by base score descending first
    results.sort(key=lambda x: x["_base_score"], reverse=True)

    # Apply diversity penalty: -0.1 for each article whose topic is already
    # represented in the top-10 positions seen so far
    topic_seen: set[str] = set()
    for idx, item in enumerate(results):
        topic = item.get("topic", "unknown")
        penalty = 0.1 if topic in topic_seen else 0.0
        item["final_score"] = item["_base_score"] - penalty
        if idx < 10:
            topic_seen.add(topic)

    # Re-sort by final score
    results.sort(key=lambda x: x["final_score"], reverse=True)

    # Strip internal scoring keys before returning
    for item in results:
        item.pop("_base_score", None)

    return {"user_id": user_id, "articles": results[:20]}


@app.post("/engage")
async def engage(req: EngageRequest) -> dict:
    """
    Record an engagement signal and update the user's interest vector via EMA.
    user_vec = (1 - alpha) * user_vec + alpha * (article_vec * weight)

    Example: {"user_id": "x", "article_id": 1, "signal": "shared"}
    """
    weight = ENGAGEMENT_WEIGHTS[req.signal]

    # Qdrant point IDs are integers when seeded; pass int if numeric, str otherwise
    qdrant_id = int(req.article_id) if isinstance(req.article_id, (int, str)) and str(req.article_id).isdigit() else req.article_id

    # Fetch the article's embedding from Qdrant
    qdrant = vector_store.get_client()
    points = qdrant.retrieve(
        collection_name="articles",
        ids=[qdrant_id],
        with_vectors=True,
    )
    if not points:
        raise HTTPException(status_code=404, detail=f"Article '{req.article_id}' not found.")

    article_vec = np.array(points[0].vector, dtype=np.float32)

    # Load or cold-initialise user vector
    user_vec = _load_user_vec(req.user_id)
    if user_vec is None:
        user_vec = np.zeros(VECTOR_DIM, dtype=np.float32)

    # EMA update
    user_vec = (1.0 - EMA_ALPHA) * user_vec + EMA_ALPHA * (article_vec * weight)

    _save_user_vec(req.user_id, user_vec)
    return {"status": "ok", "user_id": req.user_id, "signal": req.signal}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("FEATURE_FEED_PORT", 8011)),
        reload=True,
    )
