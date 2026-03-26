"""
Feature ARC — Article Intelligence

Performs three analysis tasks on ingested articles:
1. NER (Named Entity Recognition) — via spaCy en_core_web_sm + alias resolution
2. Entity Graph — Entity nodes and CO_OCCURS edges in Neo4j
3. Sentiment Analysis — via GPT-4o-mini (structured JSON output)

Also exposes story-arc assembly with GPT-4o predictions.

Endpoints:
  GET  /health
  POST /arc/process   — run full pipeline on an article
  GET  /arc/{topic}   — assembled story arc with timeline, entities, predictions
"""

import json
import logging
import os
import re
import sys
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from neo4j import GraphDatabase
from pydantic import BaseModel
from sqlalchemy import create_engine, text

import kafka_client
from llm_client import complete

log = logging.getLogger(__name__)
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))


# ── JSON helpers ───────────────────────────────────────────────────────────────

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def _parse_json(raw: str) -> dict:
    """Parse JSON from a GPT response, stripping markdown code fences if present."""
    raw = raw.strip()
    m = _FENCE_RE.match(raw)
    if m:
        raw = m.group(1).strip()
    return json.loads(raw)


# ── Alias resolution ───────────────────────────────────────────────────────────

ALIAS_FILE = os.path.join(
    os.path.dirname(__file__), "..", "..", "shared", "data", "entity_aliases.json"
)

DEFAULT_ALIASES: dict[str, str] = {
    "RBI": "Reserve Bank of India",
    "Sebi": "SEBI",
    "PM Modi": "Narendra Modi",
    "FM": "Nirmala Sitharaman",
    "BSE": "Bombay Stock Exchange",
    "NSE": "National Stock Exchange",
    "GoI": "Government of India",
    "SBI": "State Bank of India",
    "HDFC": "HDFC Bank",
    "IT": "Information Technology",
    "MoF": "Ministry of Finance",
    "PMO": "Prime Minister's Office",
    "CBI": "Central Bureau of Investigation",
    "ED": "Enforcement Directorate",
    "IRDAI": "Insurance Regulatory and Development Authority of India",
}

_alias_map: dict[str, str] = {}


def load_aliases() -> dict[str, str]:
    global _alias_map
    if not _alias_map:
        try:
            with open(ALIAS_FILE) as f:
                _alias_map = json.load(f)
        except FileNotFoundError:
            _alias_map = dict(DEFAULT_ALIASES)
    return _alias_map


def resolve_alias(name: str) -> str:
    return load_aliases().get(name, name)


def ensure_alias_file() -> None:
    os.makedirs(os.path.dirname(ALIAS_FILE), exist_ok=True)
    if not os.path.exists(ALIAS_FILE):
        with open(ALIAS_FILE, "w") as f:
            json.dump(DEFAULT_ALIASES, f, indent=2)
        log.info("Created entity_aliases.json with %d entries", len(DEFAULT_ALIASES))


# ── spaCy NER pipeline ─────────────────────────────────────────────────────────

ENTITY_TYPES = {"ORG", "PERSON", "GPE", "MONEY", "PERCENT"}

_LEADING_ARTICLE_RE = re.compile(r"^[Tt]he\s+")

_nlp = None


def get_nlp():
    global _nlp
    if _nlp is None:
        import spacy  # lazy import so test mocking is easier

        _nlp = spacy.load("en_core_web_sm")
    return _nlp


def extract_entities(text: str) -> list[tuple[str, str, int]]:
    """Run NER and alias resolution.

    Returns a list of (canonical_name, entity_type, sentence_index).
    """
    nlp = get_nlp()
    doc = nlp(text)

    # Build token-index → sentence-index map
    sent_map: dict[int, int] = {}
    for si, sent in enumerate(doc.sents):
        for token in sent:
            sent_map[token.i] = si

    results: list[tuple[str, str, int]] = []
    for ent in doc.ents:
        if ent.label_ not in ENTITY_TYPES:
            continue
        name = ent.text.strip()
        # Strip leading "The "/"the " from org names before alias lookup
        # so "The Reserve Bank of India" and "Reserve Bank of India" unify
        if ent.label_ == "ORG":
            name = _LEADING_ARTICLE_RE.sub("", name)
        canonical = resolve_alias(name)
        sent_idx = sent_map.get(ent.start, 0)
        results.append((canonical, ent.label_, sent_idx))

    return results


# ── Neo4j entity graph ─────────────────────────────────────────────────────────

_neo4j_driver = None


def get_neo4j():
    global _neo4j_driver
    if _neo4j_driver is None:
        _neo4j_driver = GraphDatabase.driver(
            os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
            auth=(
                os.environ.get("NEO4J_USER", "neo4j"),
                os.environ.get("NEO4J_PASSWORD", "password"),
            ),
        )
    return _neo4j_driver


def update_entity_graph(article_id: str, entities: list[tuple[str, str, int]]) -> None:
    """MERGE Entity nodes and CO_OCCURS edges in Neo4j."""
    driver = get_neo4j()
    now = datetime.now(timezone.utc).isoformat()

    with driver.session() as session:
        for name, etype, _ in entities:
            session.run(
                """
                MERGE (e:Entity {name: $name})
                ON CREATE SET e.type = $type,
                              e.first_seen = $now,
                              e.last_seen  = $now,
                              e.article_count = 1
                ON MATCH SET  e.last_seen  = $now,
                              e.article_count = e.article_count + 1
                """,
                name=name,
                type=etype,
                now=now,
            )

        unique_names = list({name for name, _, _ in entities})
        for i, n1 in enumerate(unique_names):
            for n2 in unique_names[i + 1 :]:
                session.run(
                    """
                    MATCH (e1:Entity {name: $n1}), (e2:Entity {name: $n2})
                    MERGE (e1)-[r:CO_OCCURS]-(e2)
                    ON CREATE SET r.weight = 1, r.articles = [$article_id]
                    ON MATCH SET  r.weight = r.weight + 1,
                                  r.articles = CASE
                                    WHEN $article_id IN r.articles THEN r.articles
                                    ELSE r.articles + [$article_id]
                                  END
                    """,
                    n1=n1,
                    n2=n2,
                    article_id=article_id,
                )


# ── PostgreSQL ─────────────────────────────────────────────────────────────────

_engine = None


def get_engine():
    global _engine
    if _engine is None:
        db_url = os.environ.get(
            "DATABASE_URL",
            "postgresql+psycopg2://postgres:postgres@localhost:5432/etnews",
        )
        _engine = create_engine(db_url)
    return _engine


_CREATE_SENTIMENTS_TABLE = """
CREATE TABLE IF NOT EXISTS article_sentiments (
    id              SERIAL PRIMARY KEY,
    article_id      TEXT NOT NULL,
    topic           TEXT,
    sentiment_score FLOAT,
    label           TEXT,
    pub_date        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
)
"""


def init_db() -> None:
    try:
        with get_engine().connect() as conn:
            conn.execute(text(_CREATE_SENTIMENTS_TABLE))
            conn.commit()
        log.info("DB: article_sentiments table ready")
    except Exception as exc:
        log.warning("DB init skipped (infrastructure not available): %s", exc)


# ── Sentiment scoring ──────────────────────────────────────────────────────────

_SENTIMENT_SYSTEM = (
    "Score the sentiment of this financial news article. "
    'Return JSON only: {"score": float 0.0-1.0, '
    '"label": "positive"|"neutral"|"negative", "reason": "one sentence"}'
)


def score_sentiment(text: str) -> dict:
    raw = complete(
        f"Article:\n{text[:2000]}",
        system=_SENTIMENT_SYSTEM,
        model="gpt-4o-mini",
        max_tokens=256,
    )
    log.debug("sentiment raw response: %s", raw)
    return _parse_json(raw)


def store_sentiment(
    article_id: str, topic: str, sentiment: dict, pub_date: str | None
) -> None:
    pd_val = None
    if pub_date:
        try:
            pd_val = datetime.fromisoformat(pub_date)
        except ValueError:
            pass

    with get_engine().connect() as conn:
        conn.execute(
            text(
                """
                INSERT INTO article_sentiments
                    (article_id, topic, sentiment_score, label, pub_date)
                VALUES (:article_id, :topic, :score, :label, :pub_date)
                """
            ),
            {
                "article_id": article_id,
                "topic": topic,
                "score": float(sentiment.get("score", 0.5)),
                "label": sentiment.get("label", "neutral"),
                "pub_date": pd_val,
            },
        )
        conn.commit()


# ── Story arc assembly ─────────────────────────────────────────────────────────


def get_sentiment_timeline(topic: str) -> list[dict]:
    """Fetch timeline rows for a topic using bidirectional substring matching.

    Handles the mismatch between the topic stored by the agent (e.g. "BJP")
    and the topic searched by the user (e.g. "BJP TMC violence"):
      - stored topic contains search term  → "BJP TMC" ILIKE '%BJP%'     ✓
      - search term contains stored topic  → "BJP TMC violence" ILIKE '%BJP%' ✓
    """
    with get_engine().connect() as conn:
        result = conn.execute(
            text(
                """
                SELECT article_id, sentiment_score, label, pub_date
                FROM article_sentiments
                WHERE topic ILIKE :pattern
                   OR :topic ILIKE '%' || topic || '%'
                ORDER BY pub_date ASC NULLS LAST
                """
            ),
            {"pattern": f"%{topic}%", "topic": topic},
        )
        return [dict(row._mapping) for row in result]


def get_topic_entities(topic: str, limit: int = 10) -> list[dict]:
    driver = get_neo4j()
    with driver.session() as session:
        result = session.run(
            """
            MATCH (e:Entity)
            WHERE toLower(e.name) CONTAINS toLower($topic)
               OR toLower($topic) CONTAINS toLower(e.name)
            WITH e
            MATCH (e)-[r:CO_OCCURS]-(other:Entity)
            RETURN other.name AS name, other.type AS type, sum(r.weight) AS connections
            ORDER BY connections DESC
            LIMIT $limit
            """,
            topic=topic,
            limit=limit,
        )
        rows = [dict(r) for r in result]

        # Fallback: top globally connected entities when no topic-specific match
        if not rows:
            result2 = session.run(
                """
                MATCH (e:Entity)-[r:CO_OCCURS]-(other:Entity)
                RETURN other.name AS name, other.type AS type, sum(r.weight) AS connections
                ORDER BY connections DESC
                LIMIT $limit
                """,
                limit=limit,
            )
            rows = [dict(r) for r in result2]

        return rows


def compute_sentiment_trend(timeline: list[dict]) -> str:
    scores = [
        r["sentiment_score"]
        for r in timeline
        if r.get("sentiment_score") is not None
    ]
    if len(scores) < 6:
        return "stable"
    first3 = sum(scores[:3]) / 3
    last3 = sum(scores[-3:]) / 3
    if last3 > first3:
        return "improving"
    if last3 < first3:
        return "declining"
    return "stable"


def generate_predictions(arc_context: dict) -> dict:
    """Call GPT-4o to produce predictions for the story arc.

    Requires at least 2 articles in the arc; returns an empty result otherwise.
    """
    if arc_context.get("article_count", 0) < 2:
        log.info(
            "Skipping predictions: article_count=%d < 2", arc_context.get("article_count")
        )
        return {"predictions": [], "contrarian_view": "", "watch_for": ""}

    log.info("Generating predictions. arc_context=%s", json.dumps(arc_context, default=str))

    prompt = (
        f"Given this news story arc: {json.dumps(arc_context, default=str)}\n"
        "Return JSON only:\n"
        '{"predictions": ["most likely development 1", "most likely development 2", '
        '"most likely development 3"], '
        '"contrarian_view": "one overlooked angle", '
        '"watch_for": "single most important signal to monitor"}'
    )
    raw = complete(prompt, model="gpt-4o", max_tokens=512)
    log.info("Predictions raw response: %s", raw)
    return _parse_json(raw)


# ── FastAPI app ────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    ensure_alias_file()
    yield


app = FastAPI(title="Feature: ARC", version="1.0.0", lifespan=lifespan)


class ArticleIn(BaseModel):
    article_id: str
    topic: str
    text: str
    pub_date: str | None = None


class ExtractTopicRequest(BaseModel):
    title: str
    summary: str = ""


_EXTRACT_TOPIC_SYSTEM = (
    "Extract the single most important searchable topic from this news article title "
    "and summary. Return only 1-3 words that best identify the main entity or story. "
    "Examples:\n"
    "'Here's what Zerodha's Nithin Kamath said on Sebi app' → 'SEBI Zerodha'\n"
    "'RBI holds repo rate at 6.5% in March meeting' → 'RBI repo rate'\n"
    "'JPMorgan launches credit default swaps against Microsoft' → 'JPMorgan Microsoft'\n"
    "'West Asia turmoil to swell fertiliser subsidy' → 'fertiliser subsidy'\n"
    "Return ONLY the topic words, nothing else."
)


def _fallback_topic(title: str) -> str:
    """Return first 2 capitalised words from the title."""
    words = [w for w in title.split() if w and w[0].isupper()]
    return " ".join(words[:2]) or " ".join(title.split()[:2])


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "feature-arc"}


@app.post("/extract-topic")
async def extract_topic_endpoint(req: ExtractTopicRequest) -> dict:
    """Use GPT-4o-mini to extract the most searchable topic from a title + summary."""
    try:
        raw = complete(
            f"Title: {req.title}\nSummary: {req.summary}",
            system=_EXTRACT_TOPIC_SYSTEM,
            model="gpt-4o-mini",
            max_tokens=20,
        )
        topic = raw.strip().splitlines()[0].strip().strip("'\".")
        return {"topic": topic or _fallback_topic(req.title)}
    except Exception:
        log.warning("extract-topic GPT call failed, using fallback for: %s", req.title)
        return {"topic": _fallback_topic(req.title)}


@app.post("/arc/process")
async def process_article(article: ArticleIn) -> dict:
    entities = extract_entities(article.text)

    try:
        update_entity_graph(article.article_id, entities)
    except Exception as exc:
        log.warning("Neo4j update failed (continuing): %s", exc)

    sentiment = score_sentiment(article.text)
    store_sentiment(article.article_id, article.topic, sentiment, article.pub_date)

    return {
        "article_id": article.article_id,
        "entities": [{"name": n, "type": t, "sentence": s} for n, t, s in entities],
        "sentiment": sentiment,
    }


@app.get("/topics")
def get_topics() -> dict:
    """Return top entity names from Neo4j as topic suggestions."""
    try:
        with get_neo4j().session() as session:
            result = session.run(
                """
                MATCH (e:Entity)
                WHERE e.article_count > 0
                RETURN e.name as name, e.article_count as count
                ORDER BY count DESC
                LIMIT 10
                """
            )
            topics = [r["name"] for r in result]
            return {"topics": topics if topics else ["RBI", "SEBI", "Markets", "Budget", "Nifty"]}
    except Exception:
        return {"topics": ["RBI", "SEBI", "Markets", "Budget", "Nifty"]}


@app.get("/arc/{topic}")
async def get_arc(topic: str) -> dict:
    timeline = get_sentiment_timeline(topic)
    entities = get_topic_entities(topic)
    trend = compute_sentiment_trend(timeline)

    arc_context = {
        "topic": topic,
        "article_count": len(timeline),
        "sentiment_trend": trend,
        "key_entities": entities[:5],
        "timeline": [
            {
                "article_id": r["article_id"],
                "score": r["sentiment_score"],
                "label": r["label"],
            }
            for r in timeline[-10:]
        ],
    }

    try:
        preds = generate_predictions(arc_context)
    except Exception:
        log.exception("Prediction generation failed for topic=%r", topic)
        preds = {"predictions": [], "contrarian_view": "", "watch_for": ""}

    return {
        "topic": topic,
        "timeline": timeline,
        "sentiment_trend": trend,
        "key_entities": entities,
        "article_count": len(timeline),
        "predictions": preds.get("predictions", []),
        "contrarian_view": preds.get("contrarian_view", ""),
        "watch_for": preds.get("watch_for", ""),
    }


# ── Kafka worker ───────────────────────────────────────────────────────────────


def kafka_worker() -> None:
    topic = os.environ.get("KAFKA_TOPIC_PROCESSED_ARTICLES", "processed-articles")
    log.info("ARC Kafka worker consuming '%s'", topic)
    for article in kafka_client.consume(topic, group_id="feature-arc"):
        try:
            content = f"{article.get('title', '')} {article.get('content', '')}"
            article_id = str(article.get("id", ""))
            topic_name = article.get("topic", "general")
            entities = extract_entities(content)
            update_entity_graph(article_id, entities)
            sentiment = score_sentiment(content)
            store_sentiment(article_id, topic_name, sentiment, article.get("pub_date"))
            log.info(
                "ARC processed article_id=%s entities=%d sentiment=%s",
                article_id,
                len(entities),
                sentiment.get("label"),
            )
        except Exception as exc:
            log.exception("ARC processing failed: %s", exc)


if __name__ == "__main__":
    import uvicorn

    t = threading.Thread(target=kafka_worker, daemon=True)
    t.start()
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("FEATURE_ARC_PORT", 8004)),
    )
