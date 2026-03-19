# ET AI News Platform

**PS8 submission — ET AI Hackathon 2026**

An AI-powered, microservices news platform built for the Economic Times that brings
personalisation, multilingual access, intelligent briefings, story tracking, and
AI-generated audio to ET readers.

---

## Planned Features

| # | Feature | Service | Status |
|---|---|---|---|
| 1 | **Vernacular Engine** — translate ET articles to Hindi, Tamil, Telugu, Bengali | `feature-vernacular` | **Done** |
| 2 | **Personalised Feed** — rank articles by reader interest using semantic similarity | `feature-feed` | In progress |
| 3 | **News Navigator** — RAG-powered briefings: ask any financial question, get sourced answers | `feature-briefing` | In progress |
| 4 | **Story Arc Tracker** — NER + entity knowledge graph + sentiment trends over time | `feature-arc` | In progress |
| 5 | **AI Video Studio** — auto-generate broadcast-style audio summaries via OpenAI TTS | `feature-video` | In progress |

---

## Architecture Overview

```
                    +--------------+
                    |  Next.js UI  |
                    +------+-------+
                           | REST / SSE
                    +------v-------+
                    |  api-server  |   <-- auth, articles, routing
                    +------+-------+
                           |
          +----------------+-----------------+
          |                |                 |
  +-------v------+ +-------v------+ +--------v-------+
  | feature-feed | |feature-brief.| |  feature-arc   |
  | (ranking)    | | (RAG+GPT-4o) | | (NER + Neo4j)  |
  +--------------+ +--------------+ +----------------+
                           |
              +------------+-----------+
              |                        |
    +---------v------+    +------------v-------+
    | feature-video  |    | feature-vernacular |
    | (OpenAI TTS)   |    | (GPT-4o translate) |  <-- IMPLEMENTED
    +----------------+    +--------------------+

  Kafka --> ingestion-pipeline --> Qdrant (vectors) + Postgres
```

### Monorepo structure

```
et-news-platform/
├── services/
│   ├── ingestion-pipeline/   # Kafka consumer -> embed -> Qdrant
│   ├── api-server/           # FastAPI main backend (port 8000)
│   ├── feature-feed/         # Personalised ranking (port 8001)
│   ├── feature-briefing/     # RAG briefings (port 8002)
│   ├── feature-video/        # OpenAI TTS audio (port 8003)
│   ├── feature-arc/          # NER + Neo4j + sentiment (port 8004)
│   └── feature-vernacular/   # Translation engine (port 8005)  <-- DONE
├── frontend/                 # Next.js 14 + TypeScript (port 3000)
├── shared/                   # llm_client.py, vector_store.py, kafka_client.py
├── docker-compose.yml
└── .env.example
```

### Tech stack

| Layer | Technology |
|---|---|
| LLM | OpenAI GPT-4o (generation, translation, sentiment) |
| Embeddings | OpenAI text-embedding-3-small |
| Audio | OpenAI TTS (tts-1) |
| Vector store | Qdrant |
| Graph database | Neo4j |
| Cache / broker | Redis |
| Message queue | Kafka |
| Relational DB | PostgreSQL |
| API framework | FastAPI |
| Frontend | Next.js 14 + TypeScript + Tailwind |
| Infra | Docker Compose |

---

## Prerequisites

- **Docker Desktop** — installed and running
- **Python 3.11+**
- **Node.js 20+** (frontend only)
- **OpenAI API key**
- **Git**

---

## Quick Start — Infrastructure

Start the five infrastructure services with Docker Compose:

```bash
cd et-news-platform

docker compose up qdrant neo4j redis kafka postgres -d

docker ps   # verify 5 containers are running
```

Expected output from `docker ps`:

```
et-news-platform-kafka-1      Up (healthy)   0.0.0.0:9092
et-news-platform-qdrant-1     Up             0.0.0.0:6333-6334
et-news-platform-neo4j-1      Up (healthy)   0.0.0.0:7474, 7687
et-news-platform-postgres-1   Up (healthy)   0.0.0.0:5432
et-news-platform-redis-1      Up (healthy)   0.0.0.0:6379
```

---

## Feature 1: Vernacular Engine (Implemented)

Translates Economic Times articles from English into Indian regional languages
using GPT-4o with a domain-specific financial glossary.

**Supported languages:** Hindi (`hi`), Tamil (`ta`), Telugu (`te`), Bengali (`bn`),
Marathi (`mr`), Gujarati (`gu`), Kannada (`kn`), Malayalam (`ml`)

**How it works:**

1. Splits article into ~800-token chunks at paragraph boundaries
2. Injects only the glossary terms that appear in each chunk (e.g. `repo rate=रेपो दर`)
3. Translates each chunk with GPT-4o, keeping tickers and company names in English
4. Appends a localised context paragraph for economic topics (inflation, GDP, etc.)
5. Runs quality checks: length ratio [0.7–1.5], named entity presence
6. Caches result in Redis (L1, TTL 24 h) and local file (L2) — no repeat API calls

### Run locally

```bash
cd services/feature-vernacular

python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt

# Windows
set OPENAI_API_KEY=your-key-here
# macOS / Linux
export OPENAI_API_KEY=your-key-here

uvicorn main:app --reload --port 8005
```

### Test it

```bash
# Health check
curl http://localhost:8005/health

# Translate a single article
curl "http://localhost:8005/translate?article_id=001&lang=hi&text=RBI kept repo rate at 6.5%25"

# Batch translate
curl -X POST http://localhost:8005/translate/batch \
  -H "Content-Type: application/json" \
  -d '{"articles": [{"id": "001", "text": "RBI kept repo rate at 6.5%"}], "lang": "hi"}'
```

Interactive API docs: **http://localhost:8005/docs**

### Run unit tests

```bash
cd services/feature-vernacular
.venv\Scripts\activate   # or source .venv/bin/activate

pytest tests/ -v
```

```
tests/test_translator.py::TestGlossaryInjection::test_glossary_terms_used        PASSED
tests/test_translator.py::TestGlossaryInjection::test_irrelevant_glossary_not_injected PASSED
tests/test_translator.py::TestLengthRatio::test_ratio_equal_length               PASSED
tests/test_translator.py::TestLengthRatio::test_ratio_value_is_correct           PASSED
tests/test_translator.py::TestLengthRatio::test_ratio_in_range_no_warning        PASSED
tests/test_translator.py::TestLengthRatio::test_empty_source_returns_one         PASSED
tests/test_translator.py::TestQualityCheckLogsWarning::test_short_translation_logs_warning PASSED
tests/test_translator.py::TestQualityCheckLogsWarning::test_very_long_translation_logs_warning PASSED
tests/test_translator.py::TestCacheHit::test_cache_hit_skips_pipeline            PASSED
tests/test_translator.py::TestCacheHit::test_redis_l1_hit_skips_pipeline         PASSED
tests/test_translator.py::TestHealthEndpoint::test_health_returns_200            PASSED
tests/test_translator.py::TestChunking::test_single_short_paragraph              PASSED
tests/test_translator.py::TestChunking::test_splits_at_paragraph_boundary        PASSED
tests/test_translator.py::TestChunking::test_large_text_produces_multiple_chunks PASSED
tests/test_translator.py::TestTranslateEndpoint::test_unsupported_language_returns_422 PASSED
tests/test_translator.py::TestTranslateEndpoint::test_batch_unsupported_language_returns_422 PASSED
tests/test_translator.py::TestTranslateEndpoint::test_translate_calls_pipeline   PASSED

17 passed in 2.08s
```

---

## Environment Variables

```bash
cp .env.example .env
```

Open `.env` and set your OpenAI API key:

```
OPENAI_API_KEY=sk-proj-...
```

All other values are pre-configured for the local Docker setup and do not need
to be changed during development.

---

## Features Coming Next

### Feature 2: Personalised Feed (`feature-feed`, port 8001)
Ranks articles for each user by embedding their interest topics and running
cosine similarity search against the Qdrant article index.

### Feature 3: News Navigator Briefings (`feature-briefing`, port 8002)
RAG pipeline: semantic retrieval from Qdrant + GPT-4o generation.
Ask *"What is RBI's stance on inflation this quarter?"* and get a sourced,
structured briefing with citations.

### Feature 4: Story Arc Tracker (`feature-arc`, port 8004)
Runs spaCy NER on every article, stores entity co-occurrence relationships
in Neo4j, and uses GPT-4o-mini for structured sentiment scoring.
Enables queries like *"Show me all articles mentioning Adani and their sentiment trend."*

### Feature 5: AI Video Studio (`feature-video`, port 8003)
Celery pipeline that turns any article or briefing into a broadcast-ready MP3:
GPT-4o writes the script, OpenAI TTS (`tts-1`) synthesises the audio.

---

## Shared Libraries (`shared/`)

All Python services import from here — no duplicated SDK setup across services.

| Module | Purpose |
|---|---|
| `llm_client.py` | `complete()` (GPT-4o), `embed()`, `tts()`, `transcribe()` |
| `vector_store.py` | Qdrant `upsert()` / `search()` with auto collection creation |
| `kafka_client.py` | `produce()` / `consume()` generator |
