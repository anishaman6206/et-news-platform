"""
ET News Agent — autonomous orchestration layer.

Monitors newly ingested ET articles and decides which AI workflows to trigger:
  translate, arc, briefing, video, feed.

Every decision is logged to PostgreSQL for a full audit trail.

Endpoints:
  GET  /health                              → service health
  GET  /agent/decisions?limit=20            → audit trail
  GET  /agent/decisions/{article_id}        → single article decision
  GET  /agent/stats                         → aggregate stats
  POST /agent/trigger                       → manually run one cycle
  POST /agent/process-article               → process one article immediately
  GET  /agent/runs?limit=10                 → recent run summaries
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))

import requests
from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import Column, DateTime, Integer, JSON, String, Text, create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session

load_dotenv()

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

AGENT_CYCLE_MINUTES = int(os.environ.get("AGENT_CYCLE_MINUTES", "35"))
AGENT_BATCH_SIZE = int(os.getenv("AGENT_BATCH_SIZE", "5"))
INGESTION_SERVICE_URL = os.environ.get("INGESTION_SERVICE_URL", "http://localhost:8006")
VERNACULAR_SERVICE_URL = os.environ.get("VERNACULAR_SERVICE_URL", "http://localhost:8005")
ARC_SERVICE_URL = os.environ.get("ARC_SERVICE_URL", "http://localhost:8004")
BRIEFING_SERVICE_URL = os.environ.get("BRIEFING_SERVICE_URL", "http://localhost:8002")
VIDEO_SERVICE_URL = os.environ.get("VIDEO_SERVICE_URL", "http://localhost:8003")
FEED_SERVICE_URL = os.environ.get("FEED_SERVICE_URL", "http://localhost:8011")

POSTGRES_URL = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/et_news"
)

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------


class Base(DeclarativeBase):
    pass


class AgentDecision(Base):
    __tablename__ = "agent_decisions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    article_id = Column(String, nullable=False, index=True)
    article_title = Column(Text, nullable=False)
    section = Column(String, nullable=False)
    decided_at = Column(DateTime(timezone=True), nullable=False)
    reasoning = Column(Text, nullable=False)
    tools_invoked = Column(JSON, nullable=False)   # list[str]
    tool_results = Column(JSON, nullable=False)     # dict[str, Any]
    status = Column(String, nullable=False)        # completed | partial | failed
    duration_ms = Column(Integer, nullable=False)


class AgentRun(Base):
    __tablename__ = "agent_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    started_at = Column(DateTime(timezone=True), nullable=False)
    completed_at = Column(DateTime(timezone=True))
    articles_processed = Column(Integer, default=0)
    tools_invoked_total = Column(Integer, default=0)
    decisions = Column(JSON, nullable=False)       # summary dict


engine = create_engine(POSTGRES_URL, pool_pre_ping=True)


def init_db() -> None:
    try:
        Base.metadata.create_all(engine)
        log.info("DB tables agent_decisions / agent_runs ready")
    except Exception as exc:
        log.warning("Could not create DB tables: %s", exc)


# ---------------------------------------------------------------------------
# In-memory state (for /health)
# ---------------------------------------------------------------------------

_last_run_ts: float | None = None
_last_run_articles: int = 0

# ---------------------------------------------------------------------------
# Decision engine
# ---------------------------------------------------------------------------

DECISION_SYSTEM_PROMPT = """You are an autonomous news platform agent.
Given a news article, decide which workflows to trigger.
Return JSON only:
{
  "should_translate": bool,
  "translate_langs": ["hi", "ta", "te", "bn"],
  "should_update_arc": bool,
  "arc_topic": null,
  "should_generate_briefing": bool,
  "briefing_topic": null,
  "should_generate_video": bool,
  "reasoning": "one sentence explaining decisions"
}

Rules:
- Translate if: article is about economy, markets, or policy
- Update arc if: article is about ANY ongoing story that involves named
  organizations, people, or geopolitical events. This includes: companies,
  government bodies, political figures, international events, regulatory
  bodies, market indices. When in doubt, update the arc — it costs little
  and builds richer story tracking over time.
  arc_topic must be the most specific searchable name: company name, person
  name, event name, or country name (e.g. "JPMorgan", "Ukraine", "SpaceX",
  "Nirmala Sitharaman"). Never leave arc_topic null when should_update_arc
  is true.
- Generate briefing if: article score > 0.7 or topic is breaking news
- Generate video if: article is from markets, economy, finance, or policy sections,
  OR the title contains a data point (%, ₹, crore, billion, rate, index).
  Err on the side of generating — a video for every 2nd article is fine.
- Always update feed (implicit)
"""


def _parse_json(raw: str) -> dict:
    """Strip markdown code fences then parse JSON."""
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        # drop opening fence line
        cleaned = cleaned[cleaned.index("\n") + 1:]
        # drop closing fence
        if cleaned.endswith("```"):
            cleaned = cleaned[: cleaned.rfind("```")]
    return json.loads(cleaned.strip())


def get_decision(article: dict) -> dict:
    """Call GPT-4o to decide which tools to invoke for an article."""
    from llm_client import complete

    user_prompt = (
        f"Title: {article.get('title', '')}\n"
        f"Section: {article.get('section', '')}\n"
        f"Summary: {article.get('summary', '')}"
    )
    raw = complete(user_prompt, system=DECISION_SYSTEM_PROMPT)
    return _parse_json(raw)


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

_TIMEOUT = int(os.environ.get("TOOL_TIMEOUT_SECONDS", "15"))


def _is_connection_error(exc: Exception) -> bool:
    msg = str(exc)
    return "Connection refused" in msg or "Failed to establish" in msg


def _article_id_str(article: dict) -> str:
    """Always return article_id as a string."""
    return str(article.get("article_id", ""))


def _article_text(article: dict) -> str:
    """
    Return the best available text from an article dict.
    Ingestion service may return 'summary', 'topic', or neither.
    Falls back to title so text is never empty.
    """
    for key in ("summary", "content", "text", "topic"):
        val = article.get(key, "")
        if val:
            return val
    return article.get("title", "")


def _pub_date_str(article: dict) -> str:
    """Return pub_date as a YYYY-MM-DD string regardless of source format."""
    raw = article.get("pub_date", "")
    if isinstance(raw, (int, float)):
        return datetime.fromtimestamp(float(raw)).strftime("%Y-%m-%d")
    if isinstance(raw, str) and raw:
        return raw[:10]   # ISO string — take date part
    # Fall back to pub_ts (unix timestamp) if pub_date absent
    pub_ts = article.get("pub_ts")
    if pub_ts:
        return datetime.fromtimestamp(float(pub_ts)).strftime("%Y-%m-%d")
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")


def tool_translate(article: dict, langs: list[str]) -> dict:
    """
    POST /translate/batch — one call per language.
    Body: {"articles": [{"id": str, "text": str}], "lang": str}
    """
    article_item = {"id": _article_id_str(article), "text": _article_text(article)}
    results: dict[str, Any] = {}
    for lang in langs:
        payload = {"articles": [article_item], "lang": lang}
        log.info("tool_translate payload: %s", json.dumps(payload))
        try:
            resp = requests.post(
                f"{VERNACULAR_SERVICE_URL}/translate/batch",
                json=payload,
                timeout=_TIMEOUT,
            )
            resp.raise_for_status()
            results[lang] = resp.json()
        except Exception as e:
            if _is_connection_error(e):
                log.warning("translate: service offline — skipped")
                return {"status": "skipped", "reason": "service_offline"}
            raise
    return {"translations": results}


def tool_update_arc(article: dict, topic: str) -> dict:
    """
    POST /arc/process
    Body: {"article_id": str, "topic": str, "text": str, "pub_date": str}
    """
    payload = {
        "article_id": _article_id_str(article),
        "topic": topic,
        "text": _article_text(article),
        "pub_date": _pub_date_str(article),
    }
    log.info("tool_arc payload: %s", json.dumps(payload))
    try:
        resp = requests.post(
            f"{ARC_SERVICE_URL}/arc/process",
            json=payload,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        if _is_connection_error(e):
            log.warning("arc: service offline — skipped")
            return {"status": "skipped", "reason": "service_offline"}
        raise


def tool_generate_briefing(topic: str) -> dict:
    """
    GET /briefing/generate?topic=... — returns SSE stream.
    Consume the stream fully; return confirmation dict.
    """
    try:
        resp = requests.get(
            f"{BRIEFING_SERVICE_URL}/briefing/generate",
            params={"topic": topic},
            stream=True,
            timeout=30,
        )
        resp.raise_for_status()
        for line in resp.iter_lines():
            if line:
                decoded = line.decode("utf-8") if isinstance(line, bytes) else line
                if decoded.startswith("data: ") and decoded != "data: [DONE]":
                    pass  # consume stream; we only confirm completion
        return {"status": "briefing_generated", "topic": topic}
    except Exception as e:
        if _is_connection_error(e):
            log.warning("briefing: service offline — skipped")
            return {"status": "skipped", "reason": "service_offline"}
        raise


def tool_update_feed(article: dict) -> dict:
    # Feed ranking updates automatically via Qdrant — just log availability.
    log.info("Article %s is now available in feed ranking", _article_id_str(article))
    return {"status": "available_in_feed"}


def tool_generate_video(article: dict) -> dict:
    """
    POST /video/generate
    Body: {"article_id": str, "title": str, "text": str}
    """
    payload = {
        "article_id": _article_id_str(article),
        "title": article.get("title", ""),
        "text": _article_text(article),
    }
    log.info("tool_video payload: %s", json.dumps(payload))
    try:
        resp = requests.post(
            f"{VIDEO_SERVICE_URL}/video/generate",
            json=payload,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        if _is_connection_error(e):
            log.warning("video: service offline — skipped")
            return {"status": "skipped", "reason": "service_offline"}
        raise


# ---------------------------------------------------------------------------
# Already-processed check
# ---------------------------------------------------------------------------


def already_processed_ids() -> set[str]:
    """Return set of article_ids already in agent_decisions."""
    try:
        with Session(engine) as session:
            rows = session.execute(
                text("SELECT article_id FROM agent_decisions")
            ).fetchall()
            return {r[0] for r in rows}
    except Exception as exc:
        log.warning("Could not query agent_decisions: %s", exc)
        return set()


# ---------------------------------------------------------------------------
# Process a single article
# ---------------------------------------------------------------------------


def process_article(article: dict) -> dict:
    """
    Run decision engine + tools for one article.
    Returns a decision summary dict.
    """
    started = time.time()
    decided_at = datetime.now(tz=timezone.utc)
    tools_invoked: list[str] = []
    tool_results: dict[str, Any] = {}
    status = "completed"

    # --- Decision ---
    try:
        decision = get_decision(article)
    except Exception as exc:
        log.error("Decision engine failed for %s: %s", article.get("article_id"), exc)
        decision = {
            "should_translate": False,
            "translate_langs": [],
            "should_update_arc": False,
            "arc_topic": None,
            "should_generate_briefing": False,
            "briefing_topic": None,
            "should_generate_video": False,
            "reasoning": f"Decision engine error: {exc}",
        }
        status = "failed"

    reasoning = decision.get("reasoning", "")

    # --- Build task list ---
    tasks: dict[str, Any] = {}

    # Feed update is always implicit
    tasks["feed"] = lambda: tool_update_feed(article)

    if decision.get("should_translate") and decision.get("translate_langs"):
        langs = decision["translate_langs"]
        tasks["translate"] = lambda l=langs: tool_translate(article, l)

    if decision.get("should_update_arc"):
        arc_topic = decision.get("arc_topic") or article.get("title", "")
        tasks["arc"] = lambda t=arc_topic: tool_update_arc(article, t)

    if decision.get("should_generate_briefing"):
        topic = decision.get("briefing_topic") or article.get("title", "")
        tasks["briefing"] = lambda t=topic: tool_generate_briefing(t)

    if decision.get("should_generate_video"):
        tasks["video"] = lambda: tool_generate_video(article)

    # --- Execute in parallel ---
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=len(tasks) or 1) as executor:
        future_to_name = {executor.submit(fn): name for name, fn in tasks.items()}
        for future in as_completed(future_to_name):
            name = future_to_name[future]
            tools_invoked.append(name)
            try:
                tool_results[name] = future.result()
            except Exception as exc:
                err_msg = f"error: {exc}"
                tool_results[name] = {"error": str(exc)}
                errors.append(f"{name}: {exc}")
                log.error("Tool %s failed for article %s: %s", name, article.get("article_id"), exc)

    if errors and status != "failed":
        status = "partial" if len(errors) < len(tasks) else "failed"

    duration_ms = int((time.time() - started) * 1000)

    # --- Persist decision ---
    decision_row = AgentDecision(
        article_id=_article_id_str(article),
        article_title=article.get("title", ""),
        section=article.get("section", ""),
        decided_at=decided_at,
        reasoning=reasoning,
        tools_invoked=sorted(tools_invoked),
        tool_results=tool_results,
        status=status,
        duration_ms=duration_ms,
    )
    try:
        with Session(engine) as session:
            session.add(decision_row)
            session.commit()
    except Exception as exc:
        log.warning("Could not persist decision for %s: %s", article.get("article_id"), exc)

    return {
        "article_id": _article_id_str(article),
        "article_title": article.get("title", ""),
        "section": article.get("section", ""),
        "decided_at": decided_at.isoformat(),
        "reasoning": reasoning,
        "tools_invoked": sorted(tools_invoked),
        "tool_results": tool_results,
        "status": status,
        "duration_ms": duration_ms,
    }


# ---------------------------------------------------------------------------
# Agent cycle
# ---------------------------------------------------------------------------


def run_agent_cycle() -> dict:
    """
    Fetch newly ingested articles, filter unseen ones, process each,
    and log an AgentRun summary.
    """
    global _last_run_ts, _last_run_articles

    started_at = datetime.now(tz=timezone.utc)
    _last_run_ts = started_at.timestamp()
    log.info("Agent cycle started at %s", started_at.isoformat())

    decisions_summary: list[dict] = []
    total_tools = 0

    # 1. Fetch recently ingested articles
    articles: list[dict] = []
    try:
        resp = requests.get(
            f"{INGESTION_SERVICE_URL}/ingest/articles",
            params={"limit": AGENT_BATCH_SIZE},
            timeout=10,
        )
        resp.raise_for_status()
        articles = resp.json().get("articles", [])
        log.info("Fetched %d articles from ingestion service", len(articles))
    except Exception as exc:
        log.error("Could not fetch articles: %s", exc)

    # 2. Filter already-processed
    seen = already_processed_ids()
    new_articles = [a for a in articles if a.get("article_id") not in seen]
    log.info("%d new articles to process", len(new_articles))

    # 3. Process each article
    for article in new_articles:
        result = process_article(article)
        total_tools += len(result["tools_invoked"])
        decisions_summary.append(
            {
                "article_id": result["article_id"],
                "status": result["status"],
                "tools": result["tools_invoked"],
                "reasoning": result["reasoning"],
            }
        )

    completed_at = datetime.now(tz=timezone.utc)
    _last_run_articles = len(new_articles)

    run_summary = {
        "articles_processed": len(new_articles),
        "tools_invoked_total": total_tools,
        "decisions": decisions_summary,
    }

    # 4. Log run
    try:
        with Session(engine) as session:
            run = AgentRun(
                started_at=started_at,
                completed_at=completed_at,
                articles_processed=len(new_articles),
                tools_invoked_total=total_tools,
                decisions=decisions_summary,
            )
            session.add(run)
            session.commit()
    except Exception as exc:
        log.warning("Could not log agent run: %s", exc)

    log.info(
        "Agent cycle done: processed=%d tools=%d",
        len(new_articles),
        total_tools,
    )
    return run_summary


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
    scheduler.add_job(
        run_agent_cycle, "interval", minutes=AGENT_CYCLE_MINUTES, id="agent_cycle"
    )
    scheduler.start()
    log.info("Agent scheduler started — cycle every %d minutes", AGENT_CYCLE_MINUTES)
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="ET News Agent", version="1.0.0", lifespan=lifespan)

# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class ProcessArticleRequest(BaseModel):
    article_id: str
    title: str
    summary: str
    section: str
    pub_date: Optional[str] = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
def health():
    # Count today's activity
    articles_today = 0
    tools_today = 0
    try:
        today = datetime.now(tz=timezone.utc).date().isoformat()
        with Session(engine) as session:
            rows = session.execute(
                text("SELECT tools_invoked, decided_at FROM agent_decisions")
            ).fetchall()
        for row in rows:
            tools_list = row[0]
            decided_at = row[1]
            # Normalise decided_at to a date string
            if decided_at is None:
                continue
            if isinstance(decided_at, str):
                row_date = decided_at[:10]
            elif hasattr(decided_at, "date"):
                row_date = decided_at.date().isoformat()
            else:
                row_date = str(decided_at)[:10]
            if row_date != today:
                continue
            articles_today += 1
            if isinstance(tools_list, str):
                try:
                    tools_list = json.loads(tools_list)
                except Exception:
                    tools_list = []
            if isinstance(tools_list, list):
                tools_today += len(tools_list)
    except Exception:
        pass

    return {
        "status": "ok",
        "service": "agent",
        "last_run": _last_run_ts,
        "articles_processed_today": articles_today,
        "tools_invoked_today": tools_today,
    }


@app.get("/agent/decisions")
def list_decisions(limit: int = Query(20, ge=1, le=100)):
    try:
        with Session(engine) as session:
            rows = session.execute(
                text(
                    "SELECT article_id, article_title, section, decided_at, reasoning, "
                    "tools_invoked, tool_results, status, duration_ms "
                    "FROM agent_decisions ORDER BY decided_at DESC LIMIT :limit"
                ),
                {"limit": limit},
            ).mappings().all()
            return {"decisions": [dict(r) for r in rows]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/agent/decisions/{article_id}")
def get_decision_by_article(article_id: str):
    try:
        with Session(engine) as session:
            row = session.execute(
                text(
                    "SELECT article_id, article_title, section, decided_at, reasoning, "
                    "tools_invoked, tool_results, status, duration_ms "
                    "FROM agent_decisions WHERE article_id = :aid ORDER BY decided_at DESC LIMIT 1"
                ),
                {"aid": article_id},
            ).mappings().fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Article not found")
            return dict(row)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/agent/stats")
def agent_stats():
    try:
        with Session(engine) as session:
            rows = session.execute(
                text(
                    "SELECT tools_invoked, decided_at FROM agent_decisions"
                )
            ).fetchall()

        total_articles = len(rows)
        tools_breakdown: dict[str, int] = {}
        total_tools = 0
        last_run_at: str | None = None
        last_ts = None

        for row in rows:
            tools_list = row[0]
            decided_at = row[1]

            # tools_invoked may be stored as a JSON string or already a list
            if isinstance(tools_list, str):
                try:
                    tools_list = json.loads(tools_list)
                except Exception:
                    tools_list = []
            if isinstance(tools_list, list):
                for t in tools_list:
                    tools_breakdown[t] = tools_breakdown.get(t, 0) + 1
                    total_tools += 1

            if decided_at is not None:
                if isinstance(decided_at, str):
                    try:
                        decided_at = datetime.fromisoformat(decided_at)
                    except Exception:
                        decided_at = None
                if decided_at and (last_ts is None or decided_at > last_ts):
                    last_ts = decided_at
                    last_run_at = decided_at.isoformat() if hasattr(decided_at, "isoformat") else str(decided_at)

        avg = round(total_tools / total_articles, 2) if total_articles else 0.0
        return {
            "total_articles_processed": total_articles,
            "total_tools_invoked": total_tools,
            "tools_breakdown": tools_breakdown,
            "avg_tools_per_article": avg,
            "last_run_at": last_run_at,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/agent/trigger")
def trigger_cycle():
    import threading

    result: dict = {}
    error: list[str] = []

    def _run():
        try:
            result.update(run_agent_cycle())
        except Exception as exc:
            error.append(str(exc))

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=120)  # wait up to 2 min for result

    if error:
        raise HTTPException(status_code=500, detail=error[0])
    return result if result else {"status": "triggered", "message": "Cycle running in background"}


@app.post("/agent/process-article")
def process_single_article(req: ProcessArticleRequest):
    article = {
        "article_id": req.article_id,
        "title": req.title,
        "summary": req.summary,
        "section": req.section,
        "pub_date": req.pub_date or datetime.now(tz=timezone.utc).isoformat(),
    }
    try:
        result = process_article(article)
        return result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/agent/runs")
def list_runs(limit: int = Query(10, ge=1, le=50)):
    try:
        with Session(engine) as session:
            rows = session.execute(
                text(
                    "SELECT id, started_at, completed_at, articles_processed, "
                    "tools_invoked_total, decisions "
                    "FROM agent_runs ORDER BY id DESC LIMIT :limit"
                ),
                {"limit": limit},
            ).mappings().all()
            return {"runs": [dict(r) for r in rows]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8007, reload=False)
