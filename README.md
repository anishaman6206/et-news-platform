# ET AI News Platform

**PS8 submission — ET AI Hackathon 2026**

An AI-powered, microservices news platform built for the Economic Times that brings
personalisation, multilingual access, intelligent briefings, story tracking, and
AI-generated audio to ET readers.

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/et-news-platform.git
cd et-news-platform

# 2. Copy env file and add your OpenAI API key
cp .env.example .env
# Edit .env and set OPENAI_API_KEY=sk-proj-...

# 3. Start everything (Windows)
.\start-all.ps1

# 4. Open the dashboard
# http://localhost:3000
```

---

## Planned Features

| # | Feature | Service | Status |
|---|---|---|---|
| 1 | **Vernacular Engine** — translate ET articles to Hindi, Tamil, Telugu, Bengali | `feature-vernacular` | **Done** |
| 2 | **Personalised Feed** — rank articles by reader interest using semantic similarity | `feature-feed` | **Done** |
| 3 | **News Navigator** — RAG-powered briefings: ask any financial question, get sourced answers | `feature-briefing` | **Done** |
| 4 | **Story Arc Tracker** — NER + entity knowledge graph + sentiment trends over time | `feature-arc` | **Done** |
| 5 | **AI Video Studio** — auto-generate broadcast-style audio summaries via OpenAI TTS | `feature-video` | **Done** |

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
    | (OpenAI TTS)   |    | (GPT-4o translate) |  <-- ALL DONE
    +----------------+    +--------------------+

  Kafka --> ingestion-pipeline --> Qdrant (vectors) + Postgres
```

### Monorepo structure

```
et-news-platform/
├── services/
│   ├── ingestion-pipeline/   # Kafka consumer -> embed -> Qdrant
│   ├── api-server/           # FastAPI main backend (port 8000)
│   ├── feature-feed/         # Personalised ranking (port 8011)
│   ├── feature-briefing/     # RAG briefings (port 8002)
│   ├── feature-video/        # OpenAI TTS audio (port 8003)
│   ├── feature-arc/          # NER + Neo4j + sentiment (port 8004)
│   └── feature-vernacular/   # Translation engine (port 8005)
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

```mermaid
flowchart LR
  User --> |GET /translate| API
  API --> |check| Redis[(Redis L1)]
  Redis --> |cache hit| User
  Redis --> |cache miss| Chunker
  Chunker --> |800-token chunks| GPT4o[GPT-4o]
  GPT4o --> |translated chunks| Merger
  Merger --> |inject glossary terms| QA[Quality Check]
  QA --> |store| Redis
  QA --> |store| FileCache[(File L2)]
  QA --> |translated article| User
```

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

## Feature 2: Personalised Feed (Implemented)

Ranks articles for each user using semantic similarity between the
user's interest vector and article embeddings stored in Qdrant.

**How it works:**
1. Onboarding: user provides role, sectors, tickers → mapped to seed phrases → embedded via text-embedding-3-small → initial interest vector
2. Every engagement (open, scroll, share, skip) updates the vector using EMA (α=0.15) — recent behaviour dominates
3. Feed request: Qdrant ANN retrieves top 200 candidates → reranked by:
   `0.6×cosine_similarity + 0.3×recency_score + 0.1×diversity_penalty`
4. Returns top 20 articles personalised to that user

**Engagement signals:** opened(0.3), scroll_50(0.5), scroll_100(0.8), shared(1.0), skipped(−0.2)

```mermaid
flowchart LR
  User --> |POST /onboard| Onboard
  Onboard --> |embed role+sectors+tickers| OpenAI[OpenAI Embeddings]
  OpenAI --> |1536-d vector| Redis[(Redis uvec:user_id)]
  User --> |POST /engage signal| EMA[EMA Update α=0.15]
  EMA --> |updated vector| Redis
  User --> |GET /feed/user_id| Ranker
  Redis --> |user vector| Ranker
  Qdrant[(Qdrant)] --> |top 200 candidates| Ranker
  Ranker --> |rerank: cosine+recency+diversity| User
```

### Run locally

```bash
cd services/feature-feed

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

uvicorn main:app --reload --port 8011
```

### Test it

```bash
# Health check
curl http://localhost:8011/health

# Onboard a new user
curl -X POST http://localhost:8011/onboard \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u1","role":"investor","sectors":["banking"],"tickers":["HDFC"]}'

# Get personalised feed
curl http://localhost:8011/feed/u1

# Send engagement signal
curl -X POST http://localhost:8011/engage \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u1","article_id":1,"signal":"shared"}'
```

Interactive API docs: **http://localhost:8011/docs**

### Run unit tests

```bash
cd services/feature-feed
pytest tests/ -v
# 6/6 tests passing
```

---

## Feature 3: News Navigator Briefings (Implemented)

RAG pipeline that synthesises multiple ET articles on a topic into a
single structured briefing with source citations. Ask follow-up
questions and get answers grounded strictly in ET content.

**How it works:**
1. Hybrid retrieval: semantic search (Qdrant) + keyword matching → merged with RRF (Reciprocal Rank Fusion, k=60)
2. Jaccard deduplication removes near-identical articles (threshold 0.60)
3. GPT-4o generates structured JSON briefing with source_ids citing which articles support each claim
4. Redis cache (TTL 6h) — identical topic queries served instantly
5. `/briefing/ask` answers questions strictly from retrieved articles only

```mermaid
flowchart LR
  User --> |POST /briefing/generate| Retriever
  Retriever --> |semantic search| Qdrant[(Qdrant)]
  Retriever --> |keyword filter| Qdrant
  Qdrant --> |two ranked lists| RRF[RRF Merge k=60]
  RRF --> |top 15| Dedup[Jaccard Dedup 0.60]
  Dedup --> |check| Redis[(Redis cache)]
  Redis --> |cache hit| User
  Redis --> |cache miss| GPT4o[GPT-4o]
  GPT4o --> |structured JSON + source_ids| Redis
  GPT4o --> |SSE stream| User
```

### Run locally

```bash
cd services/feature-briefing
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
set OPENAI_API_KEY=your-key   # Windows
uvicorn main:app --reload --port 8002
```

### Test it

```bash
# Health
curl http://localhost:8002/health

# Generate briefing
curl "http://localhost:8002/briefing/generate?topic=RBI+repo+rate"

# Ask a question
curl -X POST http://localhost:8002/briefing/ask \
  -H "Content-Type: application/json" \
  -d '{"topic":"RBI repo rate","question":"What does this mean for home loans?"}'
```

Interactive API docs: **http://localhost:8002/docs**

### Run unit tests

```bash
cd services/feature-briefing
pytest tests/ -v
# 7/7 tests passing
```

---

## Feature 4: Story Arc Tracker (Implemented)

Tracks ongoing news stories by building an entity knowledge graph
in Neo4j, scoring sentiment over time with GPT-4o-mini, and
generating AI predictions about future developments.

**How it works:**
1. POST /arc/process: runs full pipeline on each article:
   - spaCy NER extracts entities (ORG, PERSON, GPE, MONEY, PERCENT)
   - Entity normalization: strips "The/the", applies alias resolution
   - Neo4j: MERGE Entity nodes + CO_OCCURS edges (weight = co-occurrence count)
   - GPT-4o-mini scores sentiment (0.0-1.0, label, reason)
   - PostgreSQL stores sentiment record with pub_date
2. GET /arc/{topic}: assembles full story arc:
   - Timeline of all articles with sentiment scores
   - Top entities by connection count from Neo4j
   - Sentiment trend: improving/declining/stable
   - GPT-4o predictions (requires 2+ articles)

```mermaid
flowchart LR
  Article --> |POST /arc/process| NER[spaCy NER]
  NER --> |canonical entities| Aliases[Alias Resolution]
  Aliases --> |MERGE nodes+edges| Neo4j[(Neo4j Graph)]
  Article --> |text| Sentiment[GPT-4o-mini Sentiment]
  Sentiment --> |score + label| Postgres[(PostgreSQL)]
  User --> |GET /arc/topic| Arc[Arc Assembly]
  Postgres --> |timeline| Arc
  Neo4j --> |key entities| Arc
  Arc --> |arc_context| GPT4o[GPT-4o]
  GPT4o --> |predictions + contrarian| User
```

### Run locally

```bash
cd services/feature-arc
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m spacy download en_core_web_sm
set OPENAI_API_KEY=your-key
set DATABASE_URL=postgresql://postgres:postgres@localhost:5432/etnews
uvicorn main:app --reload --port 8004
```

### Test it

```bash
# Health
curl http://localhost:8004/health

# Process an article
curl -X POST http://localhost:8004/arc/process \
  -H "Content-Type: application/json" \
  -d '{"article_id":"001","topic":"RBI","text":"RBI kept repo rate at 6.5%...","pub_date":"2026-03-20"}'

# Get story arc (process 2+ articles first)
curl http://localhost:8004/arc/RBI
```

Interactive API docs: **http://localhost:8004/docs**

### Run unit tests

```bash
pytest tests/ -v
# 8/8 tests passing
```

---

## Feature 5: AI Video Studio (Implemented)

Converts any ET article into a broadcast-style MP4 video with
AI-generated narration audio. GPT-4o writes the script, OpenAI
TTS synthesises the voice, Pillow renders the frames, FFmpeg
assembles the final video.

**How it works:**
1. GPT-4o generates a scene manifest: title_card, narration, data_callout scenes with durations totalling 45-90 seconds
2. OpenAI TTS (tts-1, alloy voice) generates MP3 audio per scene
3. pydub concatenates scene audio into one narration track
4. Pillow renders a PNG frame per scene type
5. FFmpeg assembles frames + audio into final MP4
6. Async job system — POST returns job_id immediately, poll `/video/status/{job_id}` for progress

```mermaid
flowchart LR
  User --> |POST /video/generate| Queue[Job Queue]
  Queue --> |job_id| User
  Queue --> |async thread| Script[GPT-4o Script]
  Script --> |scene manifest| TTS[OpenAI TTS]
  Script --> |scene manifest| Frames[Pillow Frames]
  TTS --> |MP3 per scene| pydub[pydub concat]
  Frames --> |PNG per scene| FFmpeg
  pydub --> |narration.mp3| FFmpeg
  FFmpeg --> |filter_complex concat| MP4[(MP4 output)]
  User --> |GET /video/status/id| Queue
  User --> |GET /video/download/id| MP4
```

**Prerequisites:** FFmpeg must be installed and on PATH.
Windows: `winget install ffmpeg`

### Run locally

```bash
cd services/feature-video
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
set OPENAI_API_KEY=your-key
uvicorn main:app --reload --port 8003
```

### Test it

```bash
# Health (confirms FFmpeg detected)
curl http://localhost:8003/health

# Generate a video (returns job_id immediately)
curl -X POST http://localhost:8003/video/generate \
  -H "Content-Type: application/json" \
  -d '{"article_id":"001","title":"RBI holds rate","text":"RBI kept repo rate at 6.5%..."}'

# Poll status
curl http://localhost:8003/video/status/{job_id}

# Download when done
curl http://localhost:8003/video/download/{job_id} --output video.mp4
```

Interactive API docs: **http://localhost:8003/docs**

### Run unit tests

```bash
cd services/feature-video
pytest tests/ -v
# 7/7 tests passing
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

## All Services Running

To run all 5 features simultaneously:

```bash
# Terminal 1 — infrastructure
docker compose up qdrant neo4j redis kafka postgres -d

# Terminal 2 — vernacular (port 8005)
cd services/feature-vernacular && uvicorn main:app --port 8005

# Terminal 3 — feed (port 8011)
cd services/feature-feed && uvicorn main:app --port 8011

# Terminal 4 — briefing (port 8002)
cd services/feature-briefing && uvicorn main:app --port 8002

# Terminal 5 — arc (port 8004)
cd services/feature-arc && uvicorn main:app --port 8004

# Terminal 6 — video (port 8003)
cd services/feature-video && uvicorn main:app --port 8003
```

## API Documentation

| Service | Port | Docs URL |
|---|---|---|
| Vernacular Engine | 8005 | http://localhost:8005/docs |
| Personalised Feed | 8011 | http://localhost:8011/docs |
| News Navigator | 8002 | http://localhost:8002/docs |
| Story Arc Tracker | 8004 | http://localhost:8004/docs |
| AI Video Studio | 8003 | http://localhost:8003/docs |

---

## Frontend

Next.js 14 dashboard with pages for all 5 features.

### Run the frontend

```bash
cd frontend
npm install
npm run dev
# Opens at http://localhost:3000
```

### Pages

| Page | URL | Feature |
|---|---|---|
| Home | / | Service health dashboard |
| Vernacular | /vernacular | Translate articles to Hindi/Tamil/Telugu/Bengali |
| Feed | /feed | Personalised article feed with engagement tracking |
| Briefing | /briefing | AI briefings with source citations and Q&A |
| Story Arc | /arc | Entity graph, sentiment timeline, predictions |
| Video Studio | /video | Generate broadcast MP4 videos from articles |

---

## Shared Libraries (`shared/`)

All Python services import from here — no duplicated SDK setup across services.

| Module | Purpose |
|---|---|
| `llm_client.py` | `complete()` (GPT-4o), `embed()`, `tts()`, `transcribe()` |
| `vector_store.py` | Qdrant `upsert()` / `search()` with auto collection creation |
| `kafka_client.py` | `produce()` / `consume()` generator |
