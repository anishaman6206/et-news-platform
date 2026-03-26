"""
Feature Briefing — Hybrid RAG + Structured Briefing Generation

Pipeline per request:
  1. Hybrid retrieval  : semantic (Qdrant ANN) + keyword (scroll+filter) → RRF merge
  2. Deduplication     : drop near-duplicate titles (Jaccard > 60%)
  3. Briefing          : GPT-4o → structured JSON (summary, developments, stakeholders …)
  4. Caching           : Redis, TTL 6 h, key = sha256(topic + sorted titles)
  5. Streaming         : Server-Sent Events

Endpoints:
  GET  /health
  POST /briefing/generate   body: {"topic": "...", "max_articles": 15}
  GET  /briefing/generate   ?topic=...&max_articles=15
  POST /briefing/ask        body: {"topic": "...", "question": "..."}
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))

from dotenv import load_dotenv

load_dotenv()

import redis as redis_lib
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import vector_store
from llm_client import complete, complete_stream, embed

app = FastAPI(title="Feature: Briefing", version="1.0.0")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CACHE_TTL = 6 * 3600       # 6 hours
RRF_K = 60                 # RRF rank constant
TOP_N = 15                 # articles after RRF merge
DEDUP_THRESHOLD = 0.60     # Jaccard similarity above which titles are duplicates

BRIEFING_SYSTEM = (
    "You are an ET financial analyst. Output valid JSON only. "
    "Cite article numbers for every claim using source_ids array."
)

ASK_SYSTEM = (
    "You are an ET financial analyst. "
    "Answer using ONLY the provided articles. If answer not in articles, say so."
)

# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------


def get_redis() -> redis_lib.Redis:
    return redis_lib.Redis(
        host=os.environ.get("REDIS_HOST", "localhost"),
        port=int(os.environ.get("REDIS_PORT", 6379)),
        db=1,                   # separate DB from feature-feed (db=0)
        decode_responses=False,
    )


# ---------------------------------------------------------------------------
# Retrieval helpers
# ---------------------------------------------------------------------------


def _semantic_retrieve(query: str, limit: int = 50) -> list[dict]:
    """Embed query → Qdrant cosine search."""
    vec = embed(query)
    return vector_store.search("articles", vec, limit=limit)


def _keyword_retrieve(query: str, limit: int = 50) -> list[dict]:
    """
    Scroll the Qdrant collection and filter in Python for title word overlap.
    No full-text index required; safe for any collection size up to `limit`.
    """
    words = {w for w in re.split(r"\W+", query.lower()) if len(w) > 2}
    if not words:
        return []
    try:
        client = vector_store.get_client()
        records, _ = client.scroll(
            collection_name="articles",
            with_payload=True,
            with_vectors=False,
            limit=limit,
        )
        results: list[dict] = []
        for rec in records:
            if not rec.payload:
                continue
            title_words = set(re.split(r"\W+", rec.payload.get("title", "").lower()))
            if words & title_words:          # at least one query word in title
                results.append(dict(rec.payload))
        return results
    except Exception:
        return []


# ---------------------------------------------------------------------------
# RRF merge
# ---------------------------------------------------------------------------


def _rrf_merge(
    semantic: list[dict],
    keyword: list[dict],
    top_n: int = TOP_N,
) -> list[dict]:
    """
    Reciprocal Rank Fusion.
    score(d) = 1/(RRF_K + rank_semantic) + 1/(RRF_K + rank_keyword)
    Articles that appear in only one list get only that list's term.
    """

    def doc_key(doc: dict) -> str:
        return str(doc.get("article_id") or doc.get("title", ""))

    scores: dict[str, float] = {}
    docs: dict[str, dict] = {}

    for rank, doc in enumerate(semantic):
        k = doc_key(doc)
        scores[k] = scores.get(k, 0.0) + 1.0 / (RRF_K + rank)
        docs[k] = doc

    for rank, doc in enumerate(keyword):
        k = doc_key(doc)
        scores[k] = scores.get(k, 0.0) + 1.0 / (RRF_K + rank)
        if k not in docs:
            docs[k] = doc

    sorted_keys = sorted(scores, key=lambda k: scores[k], reverse=True)
    return [docs[k] for k in sorted_keys[:top_n]]


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------


def _jaccard(a: str, b: str) -> float:
    wa = set(a.lower().split())
    wb = set(b.lower().split())
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def _deduplicate(articles: list[dict]) -> list[dict]:
    """
    Remove near-duplicate articles (Jaccard title similarity > DEDUP_THRESHOLD).
    When two articles are duplicates, keep the one with the longer title.
    """
    kept: list[dict] = []
    for article in articles:
        title = article.get("title", "")
        dup_idx: int | None = None
        for i, existing in enumerate(kept):
            if _jaccard(title, existing.get("title", "")) > DEDUP_THRESHOLD:
                dup_idx = i
                break
        if dup_idx is None:
            kept.append(article)
        elif len(title) > len(kept[dup_idx].get("title", "")):
            kept[dup_idx] = article   # replace with longer title
    return kept


# ---------------------------------------------------------------------------
# Hybrid retrieve (semantic + keyword → RRF → dedup)
# ---------------------------------------------------------------------------


def _hybrid_retrieve(topic: str, max_articles: int = TOP_N) -> list[dict]:
    semantic = _semantic_retrieve(topic)
    keyword = _keyword_retrieve(topic)
    merged = _rrf_merge(semantic, keyword, top_n=max_articles)
    return _deduplicate(merged)


# ---------------------------------------------------------------------------
# Caching
# ---------------------------------------------------------------------------


def _cache_key(topic: str, articles: list[dict]) -> str:
    titles = sorted(a.get("title", "") for a in articles)
    raw = topic + "|" + "|".join(titles)
    return "briefing:" + hashlib.sha256(raw.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Briefing generation
# ---------------------------------------------------------------------------


def _build_article_prompt(articles: list[dict]) -> str:
    lines = [
        f"[{i}] {a.get('title', 'Unknown')} — {a.get('section', 'general')}"
        for i, a in enumerate(articles, 1)
    ]
    return "\n".join(lines)


def _strip_fences(text: str) -> str:
    """Remove markdown code fences GPT-4o sometimes wraps around JSON output.

    SSE spec only reads lines that start with 'data:'. If the raw GPT output
    has newlines inside a fenced block (```json\\n{...}\\n```), every line
    after the first is silently dropped by the EventSource parser on the
    client, causing a parse failure. Stripping fences here keeps the JSON
    on a single logical line so the SSE data field is always valid.
    """
    text = text.strip()
    text = re.sub(r"^```json\s*\n?", "", text)
    text = re.sub(r"^```\s*\n?", "", text)
    text = re.sub(r"\n?```\s*$", "", text)
    return text.strip()


def _generate_briefing(topic: str, articles: list[dict]) -> str:
    article_text = _build_article_prompt(articles)
    prompt = (
        f"Topic: {topic}\n\n"
        f"Articles:\n{article_text}\n\n"
        "Generate the briefing JSON matching this schema exactly:\n"
        '{"summary": "...", "key_developments": [{"text": "...", "source_ids": [1]}], '
        '"stakeholders": [{"name": "...", "role": "...", "sentiment": "..."}], '
        '"open_questions": ["..."], "what_to_watch": ["..."]}'
    )
    raw = complete(prompt, system=BRIEFING_SYSTEM, max_tokens=2048)
    stripped = _strip_fences(raw)
    # SSE requires single-line data fields — compact to one line
    try:
        return json.dumps(json.loads(stripped))
    except json.JSONDecodeError:
        return stripped.replace("\n", " ")


# ---------------------------------------------------------------------------
# SSE generators (synchronous — TestClient-friendly)
# ---------------------------------------------------------------------------


def _briefing_sse(topic: str, max_articles: int):
    """Generate briefing, cache result, yield SSE events."""
    articles = _hybrid_retrieve(topic, max_articles)

    if not articles:
        payload = json.dumps({"error": "No articles found for this topic."})
        yield f"data: {payload}\n\n"
        yield "data: [DONE]\n\n"
        return

    key = _cache_key(topic, articles)
    r = get_redis()

    cached = r.get(key)
    if cached:
        cached_str = cached.decode()
        # Ensure cached value is single-line (old entries may be pretty-printed)
        try:
            cached_str = json.dumps(json.loads(cached_str))
        except json.JSONDecodeError:
            cached_str = cached_str.replace("\n", " ")
        yield f"data: {cached_str}\n\n"
        yield "data: [DONE]\n\n"
        return

    result = _generate_briefing(topic, articles)
    r.setex(key, CACHE_TTL, result.encode())

    yield f"data: {result}\n\n"
    yield "data: [DONE]\n\n"


def _ask_sse(topic: str, question: str):
    """Answer a question using article context or Qdrant retrieval."""
    if "Given this article:" in question:
        # Extract the article context embedded in the question by the frontend
        context_articles = [{"title": topic, "section": "news",
                              "text": question.split("Question:")[0]}]
        question = question.split("Question:")[-1].strip()
    else:
        context_articles = _hybrid_retrieve(topic, max_articles=5)

    lines = []
    for i, a in enumerate(context_articles, 1):
        line = f"[{i}] {a.get('title', 'Unknown')} — {a.get('section', 'general')}"
        if a.get("text"):
            line += f"\n{a['text']}"
        lines.append(line)
    article_text = "\n".join(lines)

    prompt = (
        f"Articles:\n{article_text}\n\n"
        f"Question: {question}\n\n"
        "Answer:"
    )
    for token in complete_stream(prompt, system=ASK_SYSTEM, max_tokens=1024):
        # SSE data fields must not contain bare newlines — replace with space
        safe = token.replace("\n", " ")
        if safe:
            yield f"data: {safe}\n\n"
    yield "data: [DONE]\n\n"


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class GenerateRequest(BaseModel):
    topic: str
    max_articles: int = TOP_N


class AskRequest(BaseModel):
    topic: str
    question: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "feature-briefing"}


@app.post("/briefing/generate")
async def generate_briefing_post(req: GenerateRequest) -> StreamingResponse:
    return StreamingResponse(
        _briefing_sse(req.topic, req.max_articles),
        media_type="text/event-stream",
    )


@app.get("/briefing/generate")
async def generate_briefing_get(
    topic: str, max_articles: int = TOP_N
) -> StreamingResponse:
    return StreamingResponse(
        _briefing_sse(topic, max_articles),
        media_type="text/event-stream",
    )


@app.post("/briefing/ask")
async def ask_briefing(req: AskRequest) -> StreamingResponse:
    return StreamingResponse(
        _ask_sse(req.topic, req.question),
        media_type="text/event-stream",
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("FEATURE_BRIEFING_PORT", 8002)),
        reload=True,
    )
