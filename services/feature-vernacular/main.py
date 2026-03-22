"""
Feature Vernacular — Translation Pipeline

Translates articles into Indian regional languages using OpenAI GPT-4o.
Supported target languages (ISO 639-1): hi, bn, ta, te, mr, gu, kn, ml

Pipeline per article:
  1. Split at paragraph boundaries into ~800-token chunks
  2. Translate each chunk with per-chunk glossary injection (GPT-4o)
  3. Optionally append a localised context paragraph for economic topics
  4. Run quality checks (length ratio, named entity presence)
  5. Cache result in L1 (Redis) and L2 (local file)

Endpoints:
  GET  /health
  GET  /translate?article_id=X&text=...&lang=hi
  POST /translate/batch
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import threading
from pathlib import Path
from typing import Any

# ── Path bootstrap ────────────────────────────────────────────────────────────
# Ensures `shared/` modules (llm_client, kafka_client) are importable regardless
# of where pytest or the process is launched from.
_SERVICE_DIR = Path(__file__).resolve().parent
_SHARED_DIR = _SERVICE_DIR.parent.parent / "shared"
sys.path.insert(0, str(_SHARED_DIR))

from dotenv import load_dotenv

load_dotenv()

import redis as redis_lib
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

import kafka_client
from llm_client import complete

log = logging.getLogger(__name__)
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

# ── Constants ─────────────────────────────────────────────────────────────────

SUPPORTED_LANGUAGES: dict[str, str] = {
    "hi": "Hindi",
    "bn": "Bengali",
    "ta": "Tamil",
    "te": "Telugu",
    "mr": "Marathi",
    "gu": "Gujarati",
    "kn": "Kannada",
    "ml": "Malayalam",
}

# Economic topics that trigger a localised context paragraph
LOCAL_CONTEXT_TRIGGERS: frozenset[str] = frozenset(
    ["inflation", "food prices", "employment", "gdp", "interest rate"]
)

# Approximate characters per English token (used for chunk sizing)
_CHARS_PER_TOKEN: int = 4

# Target chunk size in tokens
CHUNK_TOKEN_LIMIT: int = 800

GLOSSARY_DIR: Path = _SHARED_DIR / "data" / "glossary"
CACHE_DIR: Path = Path(os.environ.get("TRANSLATION_CACHE_DIR", ".cache/translations"))

# ── Glossary ──────────────────────────────────────────────────────────────────

_glossary_cache: dict[str, dict[str, str]] = {}


def load_glossary(lang: str) -> dict[str, str]:
    """
    Load the domain glossary for *lang* from ``shared/data/glossary/{lang}.json``.

    Results are kept in a module-level dict so the file is only read once per
    process.  Returns an empty dict when no glossary file exists.
    """
    if lang in _glossary_cache:
        return _glossary_cache[lang]

    path = GLOSSARY_DIR / f"{lang}.json"
    if not path.exists():
        log.warning("No glossary found for lang=%s (expected %s)", lang, path)
        _glossary_cache[lang] = {}
        return {}

    with path.open(encoding="utf-8") as fh:
        data: dict[str, str] = json.load(fh)

    _glossary_cache[lang] = data
    log.debug("Loaded %d glossary terms for lang=%s", len(data), lang)
    return data


def get_relevant_glossary(chunk: str, lang: str) -> dict[str, str]:
    """
    Return the subset of the *lang* glossary whose English keys appear in *chunk*.

    Matching is case-insensitive so ``"Repo Rate"`` still maps to ``"रेपो दर"``.
    Only injecting matched terms keeps the system prompt short and avoids
    confusing the model with irrelevant vocabulary.
    """
    glossary = load_glossary(lang)
    return {
        term: translation
        for term, translation in glossary.items()
        if re.search(re.escape(term), chunk, re.IGNORECASE)
    }


# ── Chunking ──────────────────────────────────────────────────────────────────


def chunk_text(text: str, token_limit: int = CHUNK_TOKEN_LIMIT) -> list[str]:
    """
    Split *text* at paragraph boundaries (``\\n\\n``) into chunks whose estimated
    token count does not exceed *token_limit*.

    Paragraphs that are individually longer than the limit are kept as a single
    chunk rather than being split mid-sentence.

    Returns a list of at least one string; never returns an empty list.
    """
    char_limit = token_limit * _CHARS_PER_TOKEN
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]

    if not paragraphs:
        return [text]

    chunks: list[str] = []
    current_paras: list[str] = []
    current_len: int = 0

    for para in paragraphs:
        para_len = len(para)
        if current_paras and current_len + para_len > char_limit:
            chunks.append("\n\n".join(current_paras))
            current_paras = [para]
            current_len = para_len
        else:
            current_paras.append(para)
            current_len += para_len

    if current_paras:
        chunks.append("\n\n".join(current_paras))

    return chunks


# ── Quality checks ────────────────────────────────────────────────────────────


# Language-aware ratio limits.
# Indian scripts (Devanagari, Tamil, Telugu, Bengali, etc.) use multi-byte
# codepoints and longer word-forms than English, so the translated string is
# naturally 2-3× longer in character count even for faithful translations.
_LANG_RATIO_LIMITS: dict[str, tuple[float, float]] = {
    "hi": (0.5, 3.5),
    "ta": (0.5, 3.5),
    "te": (0.5, 3.5),
    "bn": (0.5, 3.5),
    "mr": (0.5, 3.5),
    "gu": (0.5, 3.5),
    "kn": (0.5, 3.5),
    "ml": (0.5, 3.5),
}
_DEFAULT_RATIO_LIMITS: tuple[float, float] = (0.7, 1.5)


def check_length_ratio(source: str, translated: str, lang: str) -> float:
    """
    Compute ``len(translated) / len(source)`` and emit a WARNING when the ratio
    falls outside the acceptable range for *lang*.

    Indian-script languages use language-aware limits (0.5, 3.5) because their
    Unicode codepoints and morphology produce character counts 2-3× longer than
    equivalent English text.  Other languages use the default range (0.7, 1.5).

    Returns the ratio (float).  Returns 1.0 when *source* is empty to avoid
    division-by-zero.
    """
    if not source:
        return 1.0

    ratio = len(translated) / len(source)
    lo, hi = _LANG_RATIO_LIMITS.get(lang, _DEFAULT_RATIO_LIMITS)

    if not (lo <= ratio <= hi):
        log.warning(
            "Translation length ratio %.2f is outside [%.1f, %.1f] for lang=%s "
            "(source=%d chars, translated=%d chars)",
            ratio,
            lo,
            hi,
            lang,
            len(source),
            len(translated),
        )

    return ratio


def check_named_entities(source: str, translated: str) -> list[str]:
    """
    Identify all-caps tokens (≥ 2 chars) in *source* — typically stock tickers
    and acronyms that the model was instructed to keep in English — and warn when
    any are absent from *translated*.

    Returns the list of missing tokens (empty list means all present).
    """
    uppercase_tokens = set(re.findall(r"\b[A-Z]{2,}\b", source))
    missing = [tok for tok in uppercase_tokens if tok not in translated]

    if missing:
        log.warning(
            "Named entities possibly missing from translation: %s", missing
        )

    return missing


# ── Local context injection ───────────────────────────────────────────────────


def _needs_local_context(text: str) -> bool:
    """Return True if *text* mentions any of the economic trigger topics."""
    lower = text.lower()
    return any(trigger in lower for trigger in LOCAL_CONTEXT_TRIGGERS)


def add_local_context(translated: str, lang: str, original: str) -> str:
    """
    Append a short GPT-4o-generated localisation paragraph in *lang* when the
    *original* article discusses an economic topic from ``LOCAL_CONTEXT_TRIGGERS``.

    The paragraph contextualises the topic for Indian readers in the target language.
    Returns *translated* unchanged when no trigger is detected.
    """
    if not _needs_local_context(original):
        return translated

    lang_name = SUPPORTED_LANGUAGES.get(lang, lang)
    system = (
        f"You are an expert on the Indian economy writing for {lang_name}-speaking readers. "
        "In 2-3 sentences in the target language, write a brief contextual note explaining "
        "why this economic topic is relevant to India's current situation. "
        "Return only the context paragraph — no headings, no markdown."
    )
    prompt = (
        f"The following news article has been translated to {lang_name}:\n\n"
        f"{translated[:500]}\n\n"
        "Write a short localisation context paragraph in the same language."
    )

    context_para = complete(prompt, system=system, model="gpt-4o", max_tokens=200)
    return f"{translated}\n\n{context_para}"


# ── Translation core ──────────────────────────────────────────────────────────


def translate_chunk(chunk: str, lang: str) -> str:
    """
    Translate a single *chunk* to *lang* using GPT-4o.

    Injects only the glossary terms that actually appear in the chunk so the
    system prompt stays concise.  Company names, tickers, and numbers are kept
    in English per the system instructions.
    """
    lang_name = SUPPORTED_LANGUAGES.get(lang, lang)
    glossary_subset = get_relevant_glossary(chunk, lang)

    glossary_instruction = ""
    if glossary_subset:
        terms_str = ", ".join(f"{k}={v}" for k, v in glossary_subset.items())
        glossary_instruction = f"Use these exact terms: {terms_str}. "

    system = (
        f"Translate the following news article excerpt to {lang_name}. "
        f"{glossary_instruction}"
        "Adapt idioms culturally. "
        "Keep numbers, company names, stock tickers, and financial symbols in English. "
        "Return only the translated text, no explanation."
    )

    # Allow ~1.5× tokens out relative to estimated input token count, minimum 256
    estimated_input_tokens = max(len(chunk) // _CHARS_PER_TOKEN, 1)
    max_out = min(4096, int(estimated_input_tokens * 1.5) + 256)

    return complete(chunk, system=system, model="gpt-4o", max_tokens=max_out)


def run_translation_pipeline(text: str, lang: str, article_id: str) -> str:
    """
    Execute the full translation pipeline for one article:

    1. Chunk *text* at paragraph boundaries (~800 tokens each)
    2. Translate every chunk with glossary injection
    3. Reassemble chunks
    4. Optionally append a localised context paragraph
    5. Run quality checks (length ratio, named entity presence)

    Returns the final translated string.
    """
    chunks = chunk_text(text)
    log.info(
        "Translating article_id=%s lang=%s chunks=%d total_chars=%d",
        article_id,
        lang,
        len(chunks),
        len(text),
    )

    translated_chunks = [translate_chunk(chunk, lang) for chunk in chunks]
    translated = "\n\n".join(translated_chunks)

    translated = add_local_context(translated, lang, text)

    check_length_ratio(text, translated, lang)
    check_named_entities(text, translated)

    return translated


# ── Three-layer cache ─────────────────────────────────────────────────────────

_redis_client: redis_lib.Redis | None = None


def get_redis() -> redis_lib.Redis:
    """Return a lazily-initialised Redis client (decode_responses=True)."""
    global _redis_client
    if _redis_client is None:
        _redis_client = redis_lib.from_url(
            os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
            decode_responses=True,
        )
    return _redis_client


def _l2_path(article_id: str, lang: str) -> Path:
    """Return the L2 file-cache path for an article/language pair."""
    return CACHE_DIR / f"{article_id}_{lang}.txt"


def cache_get(article_id: str, lang: str) -> str | None:
    """
    Check L1 (Redis) then L2 (local file) for a cached translation.

    Returns the cached string on a hit, or ``None`` on a cold miss.
    Redis errors are swallowed so a Redis outage degrades gracefully to L2.
    """
    redis_key = f"trans:{article_id}:{lang}"

    # L1 — Redis
    try:
        value: str | None = get_redis().get(redis_key)
        if value:
            log.debug("Cache L1 hit  article_id=%s lang=%s", article_id, lang)
            return value
    except Exception as exc:
        log.debug("Redis unavailable (%s), falling through to L2", exc)

    # L2 — local file
    path = _l2_path(article_id, lang)
    if path.exists():
        log.debug("Cache L2 hit  article_id=%s lang=%s", article_id, lang)
        return path.read_text(encoding="utf-8")

    return None


def cache_set(article_id: str, lang: str, text: str) -> None:
    """
    Persist *text* to both L1 (Redis, TTL 86400 s) and L2 (local file).

    Redis errors are swallowed; the L2 write is always attempted.
    """
    redis_key = f"trans:{article_id}:{lang}"

    # L1 — Redis
    try:
        get_redis().setex(redis_key, 86400, text)
        log.debug("Cache L1 write article_id=%s lang=%s", article_id, lang)
    except Exception as exc:
        log.debug("Redis unavailable (%s), skipping L1 write", exc)

    # L2 — local file
    path = _l2_path(article_id, lang)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    log.debug("Cache L2 write article_id=%s lang=%s path=%s", article_id, lang, path)


def translate(text: str, lang: str, article_id: str) -> str:
    """
    Public translation entry point with three-layer caching.

    L1 (Redis) → L2 (local file) → L3 (full GPT-4o pipeline).
    Results are written back to L1 and L2 on an L3 execution.
    """
    cached = cache_get(article_id, lang)
    if cached is not None:
        return cached

    # L3 — run full pipeline
    result = run_translation_pipeline(text, lang, article_id)
    cache_set(article_id, lang, result)
    return result


# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(title="Feature: Vernacular", version="1.0.0")


class ArticleItem(BaseModel):
    """A single article payload for batch translation."""

    id: str
    text: str


class BatchTranslateRequest(BaseModel):
    """Request body for ``POST /translate/batch``."""

    articles: list[ArticleItem]
    lang: str


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe."""
    return {"status": "ok", "service": "vernacular"}


@app.get("/translate")
async def translate_article(
    article_id: str = Query(..., description="Unique article identifier"),
    text: str = Query(..., description="Full article body in English"),
    lang: str = Query(..., description="ISO 639-1 target language code"),
) -> dict[str, Any]:
    """
    Translate a single article.

    Subsequent calls with the same ``article_id`` / ``lang`` pair are served from
    cache (L1 or L2) without calling the LLM again.
    """
    if lang not in SUPPORTED_LANGUAGES:
        raise HTTPException(
            status_code=422,
            detail={
                "error": f"Unsupported language '{lang}'",
                "supported": sorted(SUPPORTED_LANGUAGES),
            },
        )
    translated = translate(text, lang, article_id)
    return {"article_id": article_id, "lang": lang, "translated": translated}


@app.post("/translate/batch")
async def translate_batch(req: BatchTranslateRequest) -> dict[str, Any]:
    """
    Translate multiple articles to the same target language.

    Each article is processed independently; cache hits short-circuit the LLM
    call for previously translated articles.
    """
    if req.lang not in SUPPORTED_LANGUAGES:
        raise HTTPException(
            status_code=422,
            detail={
                "error": f"Unsupported language '{req.lang}'",
                "supported": sorted(SUPPORTED_LANGUAGES),
            },
        )

    results = []
    for item in req.articles:
        translated = translate(item.text, req.lang, item.id)
        results.append(
            {"article_id": item.id, "lang": req.lang, "translated": translated}
        )

    return {"results": results}


# ── Kafka worker ──────────────────────────────────────────────────────────────


def kafka_worker() -> None:
    """
    Background thread that consumes ``translation-jobs`` from Kafka.

    Expected message schema: ``{ "article_id": str, "text": str, "target_lang": str }``
    """
    topic = os.environ.get("KAFKA_TOPIC_TRANSLATION_JOBS", "translation-jobs")
    log.info("Vernacular Kafka worker consuming '%s'", topic)

    for job in kafka_client.consume(topic, group_id="feature-vernacular"):
        try:
            result = translate(job["text"], job["target_lang"], job["article_id"])
            log.info(
                "Translated article_id=%s lang=%s chars=%d",
                job["article_id"],
                job["target_lang"],
                len(result),
            )
        except Exception as exc:
            log.exception("Translation job failed: %s", exc)


if __name__ == "__main__":
    import uvicorn

    t = threading.Thread(target=kafka_worker, daemon=True)
    t.start()
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("FEATURE_VERNACULAR_PORT", 8005)),
    )
