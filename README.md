# ET AI News Platform

### AI-Native News Experience — PS8 Submission · ET AI Hackathon 2026

An AI-powered microservices platform for Economic Times that delivers personalisation,
multilingual access, intelligent briefings, story tracking, AI-generated video, and autonomous
editorial agent processing to ET readers.

![Python](https://img.shields.io/badge/Python-3.11-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![Next.js](https://img.shields.io/badge/Next.js-14-black)
![FastAPI](https://img.shields.io/badge/FastAPI-0.111-green)
![GPT-4o](https://img.shields.io/badge/GPT--4o-OpenAI-412991)
![Tests](https://img.shields.io/badge/Tests-45%20passing-brightgreen)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## Demo

> 🎥 **[Watch the demo pitch video](https://drive.google.com/file/d/1h6-vdI9lkImzxV8cbhiLl6g9z6tVK1_k/view?usp=sharing)**

| News Feed | Story Arc | ET News Agent |
|---|---|---|
| ![Feed](screenshots/home.png) | ![Arc](screenshots/arc.png) | ![Agent](screenshots/agent.png) |

| AI Briefing | AI Video Studio | Hindi Translation |
|---|---|---|
| ![Briefing](screenshots/briefing.png) | ![Video](screenshots/video.png) | ![Hindi](screenshots/home.jpeg) |

---

## Features

| # | Feature | Service | Status |
|---|---|---|---|
| 1 | **Vernacular Engine** — translate ET articles to Hindi, Tamil, Telugu, Bengali | `feature-vernacular` | Done |
| 2 | **Personalised Feed** — rank articles by reader interest using semantic similarity + EMA | `feature-feed` | Done |
| 3 | **News Navigator** — RAG briefings + streaming article-context Q&A | `feature-briefing` | Done |
| 4 | **Story Arc Tracker** — NER + entity knowledge graph + sentiment trends over time | `feature-arc` | Done |
| 5 | **AI Video Studio** — auto-generate broadcast-style MP4 videos via GPT-4o + OpenAI TTS | `feature-video` | Done |
| 6 | **Ingestion Pipeline** — Kafka consumer → OpenAI embed → Qdrant upsert | `ingestion-pipeline` | Done |
| 7 | **Autonomous Agent** — reads every article, decides arc/video actions, runs 24/7 | `agent` | Done |

---

## ⚡ Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/anishaman6206/et-news-platform.git
cd et-news-platform

# 2. Copy env file and add your OpenAI API key
cp .env.example .env
# Edit .env and set OPENAI_API_KEY=sk-proj-...

# 3. Install Python dependencies for each service
pip install -r services/ingestion-pipeline/requirements.txt
pip install -r services/agent/requirements.txt
pip install -r services/feature-vernacular/requirements.txt
pip install -r services/feature-feed/requirements.txt
pip install -r services/feature-briefing/requirements.txt
pip install -r services/feature-arc/requirements.txt
pip install -r services/feature-video/requirements.txt

# 4. Install frontend dependencies
cd frontend && npm install && cd ..

# 5. Start everything
# Windows
.\start-all.ps1 -ApiKey "sk-proj-..."

# Mac / Linux
export OPENAI_API_KEY=sk-proj-...
chmod +x start-all.sh && ./start-all.sh

# 6. Open the dashboard
# http://localhost:3000
```

---

## 🏗️ Architecture

The ET AI News Platform is an AI-native microservices system built for Economic Times,
delivering personalisation, multilingual access, intelligent briefings, story tracking,
AI-generated video, and autonomous agent processing to ET readers. Seven independently
deployable services share a common infrastructure layer (Qdrant, Redis, Neo4j, PostgreSQL,
Kafka) and route all LLM calls through a single shared client (`shared/llm_client.py`)
backed by the OpenAI API.

### System Diagram

```mermaid
flowchart TD
  User([User / Client])

  subgraph Pipeline[Article Pipeline]
    Ingest[ingestion-pipeline\nport 8006]
    Agent[agent\nport 8007]
  end

  subgraph Services[Feature Services]
    V[feature-vernacular\nport 8005]
    F[feature-feed\nport 8011]
    B[feature-briefing\nport 8002]
    A[feature-arc\nport 8004]
    VD[feature-video\nport 8003]
  end

  subgraph Infra[Shared Infrastructure]
    Redis[(Redis\n:6379)]
    Qdrant[(Qdrant\n:6333)]
    Neo4j[(Neo4j\n:7687)]
    Postgres[(PostgreSQL\n:5432)]
    Kafka[(Kafka\n:9092)]
  end

  subgraph Shared[shared/]
    LLM[llm_client.py\ncomplete · complete_stream · embed · tts]
    VS[vector_store.py\nupsert · search]
    KC[kafka_client.py\nproduce · consume]
  end

  OpenAI([OpenAI API\nGPT-4o · TTS · Embeddings])

  Kafka -->|raw-articles| Ingest
  Ingest -->|embed + upsert| Qdrant
  Ingest -->|processed-articles| Kafka
  Kafka -->|processed-articles| Agent
  Agent -->|POST /arc/process| A
  Agent -->|POST /video/generate| VD

  User -->|GET /translate/batch| V
  User -->|GET /feed · POST /onboard · POST /engage| F
  User -->|POST /briefing/generate · /ask| B
  User -->|GET /arc/topic| A
  User -->|POST /video/generate · GET /video/status| VD

  V --> Redis
  F --> Redis
  F --> Qdrant
  B --> Redis
  B --> Qdrant
  A --> Neo4j
  A --> Postgres

  V --> LLM
  F --> LLM
  F --> VS
  B --> LLM
  B --> VS
  A --> LLM
  VD --> LLM
  Agent --> LLM

  VS --> Qdrant
  KC --> Kafka
  LLM --> OpenAI
```

### Service Table

| Service | Port | Key Technologies | Purpose |
|---|---|---|---|
| `ingestion-pipeline` | 8006 | Kafka, Qdrant, text-embedding-3-small | Consumes raw-articles, embeds with OpenAI, upserts to Qdrant |
| `agent` | 8007 | GPT-4o, Kafka, REST | Autonomous agent: reads articles, decides arc/video actions |
| `feature-vernacular` | 8005 | GPT-4o, Redis (L1+L2 cache) | EN → 8 Indian language translation with financial glossary |
| `feature-feed` | 8011 | Qdrant, Redis, OpenAI Embeddings | Personalised article ranking via semantic similarity + EMA |
| `feature-briefing` | 8002 | Qdrant, Redis, GPT-4o | RAG briefings with RRF retrieval, dedup, token-by-token SSE |
| `feature-arc` | 8004 | spaCy, Neo4j, PostgreSQL, GPT-4o-mini | NER → entity graph → sentiment timeline → AI predictions |
| `feature-video` | 8003 | GPT-4o, OpenAI TTS, FFmpeg, Pillow | Scene manifest → TTS audio → Pillow frames → MP4 |

### Data Flow Per Feature

| Feature | Pipeline |
|---|---|
| **Vernacular** | Article text → chunk (800 tokens) → GPT-4o + glossary injection → quality check → Redis + file cache |
| **Feed** | User signal → EMA vector update (α=0.15) → Qdrant ANN (top 200) → rerank (cosine + recency + diversity) → top 20 |
| **Briefing** | Topic query → RRF merge (semantic + keyword) → Jaccard dedup (0.60) → GPT-4o → structured JSON + source citations + SSE |
| **Arc** | Article → spaCy NER + alias resolution → Neo4j MERGE → GPT-4o-mini sentiment → PostgreSQL → GPT-4o predictions |
| **Video** | Article → GPT-4o scene manifest → OpenAI TTS per scene + Pillow PNG frames → FFmpeg concat demuxer → MP4 |

### Error Handling

- **`_parse_json()`** — strips GPT-4o markdown fences before `json.loads`; used in `feature-arc` and `feature-video`
- **3-layer cache** — Redis L1 (hot, TTL-bounded) → file/DB L2 (warm, persistent) → live pipeline (cold)
- **FFmpeg detection** — `check_ffmpeg()` runs at startup; `/health` reports `ffmpeg_available` so the frontend can disable video generation gracefully
- **Frame render guard** — returns `status=failed` with descriptive error if all frames fail; prevents silent empty-video output
- **Entity normalisation** — strips leading "The/the" from ORG entities and resolves aliases before Neo4j writes; prevents duplicate nodes
- **All services** expose `GET /health` for liveness probing and container orchestration readiness checks

### Monorepo Structure

```
et-news-platform/
├── services/
│   ├── ingestion-pipeline/   # Kafka consumer → embed → Qdrant, port 8006
│   ├── agent/                # Autonomous editorial agent, port 8007
│   ├── api-server/           # FastAPI gateway stub, port 8000
│   ├── feature-feed/         # Personalised ranking, port 8011
│   ├── feature-briefing/     # RAG briefings, port 8002
│   ├── feature-video/        # AI video generation, port 8003
│   ├── feature-arc/          # NER + Neo4j + sentiment, port 8004
│   └── feature-vernacular/   # Translation engine, port 8005
├── frontend/                 # Next.js 14 + TypeScript, port 3000
├── shared/                   # llm_client.py, vector_store.py, kafka_client.py
├── screenshots/              # UI screenshots for submission
├── start-all.ps1             # Windows one-command startup script
├── start-all.sh              # Mac/Linux one-command startup script
├── docker-compose.yml
├── ARCHITECTURE.md
├── IMPACT_MODEL.md
└── .env.example
```

---

## 🛠️ Tech Stack

| Category | Technology | Purpose |
|---|---|---|
| **LLM** | OpenAI GPT-4o | Translation, briefings, script generation, predictions |
| **LLM (fast)** | OpenAI GPT-4o-mini | Sentiment scoring (cost-efficient) |
| **Embeddings** | text-embedding-3-small | Article and user interest vectors (1536-d) |
| **Audio** | OpenAI TTS tts-1 | Narration synthesis for video studio |
| **Vector DB** | Qdrant | Semantic article search, ANN retrieval |
| **Graph DB** | Neo4j | Entity co-occurrence graph for story tracking |
| **Cache** | Redis | User vectors, translated articles, briefings |
| **Relational DB** | PostgreSQL + TimescaleDB | Sentiment time-series, article metadata |
| **Message Queue** | Kafka | Article ingestion pipeline events |
| **NLP** | spaCy en_core_web_sm | Named entity recognition |
| **Video** | FFmpeg + Pillow | Frame rendering, audio concat (FFmpeg concat demuxer), MP4 assembly |
| **Backend** | FastAPI + Python 3.11 | All 7 microservices |
| **Frontend** | Next.js 14 + TypeScript + Tailwind | Dashboard UI |
| **Infra** | Docker Compose | Local development orchestration |

---

## Prerequisites

- **Docker Desktop** — installed and running
- **Python 3.11+**
- **Node.js 20+** (frontend only)
- **FFmpeg** — `winget install ffmpeg` (Windows) or `brew install ffmpeg` (Mac)
- **OpenAI API key**

---

## 🚀 Startup Scripts

Two one-command startup scripts are included that handle everything automatically.

### Windows (`start-all.ps1`)

```powershell
# Basic usage (reads OPENAI_API_KEY from environment)
.\start-all.ps1

# With explicit API key
.\start-all.ps1 -ApiKey "sk-proj-..."
```

What it does:
1. Starts Docker infrastructure (Qdrant, Neo4j, Redis, Kafka, PostgreSQL)
2. Polls Qdrant `/healthz` until healthy (up to 60 seconds), then waits 5 more seconds for Postgres and Neo4j
3. Opens 7 separate PowerShell windows for each Python service (with FFmpeg path and env vars pre-injected)
4. Opens an 8th window for the Next.js frontend at `http://localhost:3000`
5. Prints all service ports at the end

### Mac / Linux (`start-all.sh`)

```bash
export OPENAI_API_KEY=sk-proj-...
chmod +x start-all.sh
./start-all.sh
```

What it does: same as above — Qdrant health-check loop, FFmpeg auto-detection, all 7 Python services as background processes, port listing at the end.

---

## Infrastructure Setup

Start the five infrastructure services with Docker Compose:

```bash
docker compose up qdrant neo4j redis kafka postgres -d
docker ps   # verify 5 containers are running
```

Expected output:

```
et-news-platform-kafka-1      Up (healthy)   0.0.0.0:9092
et-news-platform-qdrant-1     Up             0.0.0.0:6333-6334
et-news-platform-neo4j-1      Up (healthy)   0.0.0.0:7474, 7687
et-news-platform-postgres-1   Up (healthy)   0.0.0.0:5432
et-news-platform-redis-1      Up (healthy)   0.0.0.0:6379
```

---

## Feature 1: Vernacular Engine

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

> 📸 *Screenshot: Vernacular Engine page*
> ![Vernacular](screenshots/vernacular.png)

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

### Unit tests

```bash
cd services/feature-vernacular
pytest tests/ -v
```

```
tests/test_translator.py::TestGlossaryInjection::test_glossary_terms_used                    PASSED
tests/test_translator.py::TestGlossaryInjection::test_irrelevant_glossary_not_injected       PASSED
tests/test_translator.py::TestLengthRatio::test_ratio_equal_length                           PASSED
tests/test_translator.py::TestLengthRatio::test_ratio_value_is_correct                       PASSED
tests/test_translator.py::TestLengthRatio::test_ratio_in_range_no_warning                    PASSED
tests/test_translator.py::TestLengthRatio::test_empty_source_returns_one                     PASSED
tests/test_translator.py::TestQualityCheckLogsWarning::test_short_translation_logs_warning   PASSED
tests/test_translator.py::TestQualityCheckLogsWarning::test_very_long_translation_logs_warning PASSED
tests/test_translator.py::TestCacheHit::test_cache_hit_skips_pipeline                        PASSED
tests/test_translator.py::TestCacheHit::test_redis_l1_hit_skips_pipeline                     PASSED
tests/test_translator.py::TestHealthEndpoint::test_health_returns_200                        PASSED
tests/test_translator.py::TestChunking::test_single_short_paragraph                          PASSED
tests/test_translator.py::TestChunking::test_splits_at_paragraph_boundary                    PASSED
tests/test_translator.py::TestChunking::test_large_text_produces_multiple_chunks             PASSED
tests/test_translator.py::TestTranslateEndpoint::test_unsupported_language_returns_422       PASSED
tests/test_translator.py::TestTranslateEndpoint::test_batch_unsupported_language_returns_422 PASSED
tests/test_translator.py::TestTranslateEndpoint::test_translate_calls_pipeline               PASSED

17 passed in 2.08s
```

---

## Feature 2: Personalised Feed 

Ranks articles for each user using semantic similarity between the
user's interest vector and article embeddings stored in Qdrant.

**How it works:**

1. Onboarding: user provides role, sectors, tickers → mapped to seed phrases → embedded via text-embedding-3-small → initial interest vector
2. Every engagement (open, scroll, share, skip) updates the vector using EMA (α=0.15) — recent behaviour dominates
3. Feed request: Qdrant ANN retrieves top 200 candidates → reranked by:
   `0.6×cosine_similarity + 0.3×recency_score + 0.1×diversity_penalty`
4. Returns top 20 articles personalised to that user

**Engagement signals:** `opened` (+0.3), `scroll_50` (+0.5), `scroll_100` (+0.8), `shared` (+1.0), `skipped` (−0.2)

> 📸 *Screenshot: Personalised Feed page*
> ![Feed](screenshots/home.png)

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
set OPENAI_API_KEY=your-key-here   # Windows
# export OPENAI_API_KEY=your-key-here  # Mac/Linux

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

### Unit tests

```bash
cd services/feature-feed
pytest tests/ -v
# 6/6 tests passing
```

---

## Feature 3: News Navigator Briefings 

RAG pipeline that synthesises multiple ET articles on a topic into a
single structured briefing with source citations. Ask follow-up
questions and get answers grounded strictly in ET content.

**How it works:**

1. Hybrid retrieval: semantic search (Qdrant) + keyword matching → merged with RRF (Reciprocal Rank Fusion, k=60)
2. Jaccard deduplication removes near-identical articles (threshold 0.60)
3. GPT-4o generates structured JSON briefing with `source_ids` citing which articles support each claim
4. Redis cache (TTL 6 h) — identical topic queries served instantly
5. `/briefing/ask` answers questions strictly from retrieved articles only

> 📸 *Screenshot: News Navigator Briefing page*
> ![Briefing](screenshots/briefing.png)

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
.venv\Scripts\activate        # Windows / source .venv/bin/activate on Mac
pip install -r requirements.txt
set OPENAI_API_KEY=your-key   # Windows
uvicorn main:app --reload --port 8002
```

### Test it

```bash
# Health
curl http://localhost:8002/health

# Generate briefing (SSE stream)
curl "http://localhost:8002/briefing/generate?topic=RBI+repo+rate"

# Ask a follow-up question
curl -X POST http://localhost:8002/briefing/ask \
  -H "Content-Type: application/json" \
  -d '{"topic":"RBI repo rate","question":"What does this mean for home loans?"}'
```

Interactive API docs: **http://localhost:8002/docs**

### Unit tests

```bash
cd services/feature-briefing
pytest tests/ -v
# 7/7 tests passing
```

---

## Feature 4: Story Arc Tracker 

Tracks ongoing news stories by building an entity knowledge graph
in Neo4j, scoring sentiment over time with GPT-4o-mini, and
generating AI predictions about future developments.

**How it works:**

1. `POST /arc/process` — runs full pipeline on each article:
   - spaCy NER extracts entities (ORG, PERSON, GPE, MONEY, PERCENT)
   - Entity normalisation: strips "The/the", applies alias resolution
   - Neo4j: `MERGE` Entity nodes + `CO_OCCURS` edges (weight = co-occurrence count)
   - GPT-4o-mini scores sentiment (0.0–1.0, label, reason)
   - PostgreSQL stores sentiment record with `pub_date`
2. `GET /arc/{topic}` — assembles full story arc:
   - Timeline of all articles with sentiment scores
   - Top entities by connection count from Neo4j
   - Sentiment trend: improving / declining / stable
   - GPT-4o predictions (requires 2+ articles)

> 📸 *Screenshot: Story Arc Tracker page*
> ![Arc](screenshots/arc.png)

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

# Get story arc (process 2+ articles first for predictions)
curl http://localhost:8004/arc/RBI
```

Interactive API docs: **http://localhost:8004/docs**

### Unit tests

```bash
cd services/feature-arc
pytest tests/ -v
# 8/8 tests passing
```

---

## Feature 5: AI Video Studio 

Converts any ET article into a broadcast-style MP4 video with
AI-generated narration. GPT-4o writes the script, OpenAI TTS
synthesises the voice, Pillow renders the frames, FFmpeg assembles
the final video.

**How it works:**

1. GPT-4o generates a scene manifest: `title_card`, `narration`, `data_callout` scenes with durations totalling 45–90 seconds
2. OpenAI TTS (tts-1, alloy voice) generates MP3 audio per scene
3. FFmpeg concat demuxer joins scene audio into one narration track (no ffprobe dependency)
4. Pillow renders a PNG frame per scene type
5. FFmpeg assembles frames + audio into final MP4 via `filter_complex concat`
6. Async job system — `POST` returns `job_id` immediately; poll `/video/status/{job_id}` for progress

**Prerequisites:** FFmpeg must be installed and on PATH.
- Windows: `winget install ffmpeg`
- macOS: `brew install ffmpeg`

> 📸 *Screenshot: AI Video Studio page*
> ![Video](screenshots/video.png)

```mermaid
flowchart LR
  User --> |POST /video/generate| Queue[Job Queue]
  Queue --> |job_id| User
  Queue --> |async thread| Script[GPT-4o Script]
  Script --> |scene manifest| TTS[OpenAI TTS]
  Script --> |scene manifest| Frames[Pillow Frames]
  TTS --> |MP3 per scene| Concat[FFmpeg concat demuxer]
  Frames --> |PNG per scene| FFmpeg
  Concat --> |narration.mp3| FFmpeg
  FFmpeg --> |filter_complex concat| MP4[(MP4 output)]
  User --> |GET /video/status/id| Queue
  User --> |GET /video/download/id| MP4
```

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

### Unit tests

```bash
cd services/feature-video
pytest tests/ -v
# 7/7 tests passing
```

---

## 🌐 Frontend

Next.js 14 dashboard with a unified home feed and dedicated pages for Arc, Video, and Agent.

### Run the frontend

```bash
cd frontend
npm install
npm run dev
# Opens at http://localhost:3000

# Or use the startup script which starts the frontend automatically:
# Windows:   .\start-all.ps1
# Mac/Linux: ./start-all.sh
```

### Pages

| Page | URL | What's here |
|---|---|---|
| Home | `/` | Article feed, personalisation sidebar, translation, briefing Q&A, video buttons, agent activity panel |
| Story Arc | `/arc` | Entity graph, sentiment timeline, AI predictions |
| Video Studio | `/video` | Browse and download AI-generated MP4 videos |
| Agent | `/agent` | Live agent decision log |

> 📸 *Screenshot: Home dashboard*
> ![Home](screenshots/home.png)

---

## All Services Running (Manual)

To run all 7 services simultaneously without the startup script:

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

# Terminal 7 — ingestion pipeline (port 8006)
cd services/ingestion-pipeline && uvicorn main:app --port 8006

# Terminal 8 — autonomous agent (port 8007)
cd services/agent && uvicorn main:app --port 8007
```

---

## API Documentation

| Service | Port | Docs URL |
|---|---|---|
| Ingestion Pipeline | 8006 | http://localhost:8006/docs |
| Autonomous Agent | 8007 | http://localhost:8007/docs |
| Vernacular Engine | 8005 | http://localhost:8005/docs |
| Personalised Feed | 8011 | http://localhost:8011/docs |
| News Navigator | 8002 | http://localhost:8002/docs |
| Story Arc Tracker | 8004 | http://localhost:8004/docs |
| AI Video Studio | 8003 | http://localhost:8003/docs |

---

## 🔑 Environment Variables

```bash
cp .env.example .env
# Edit .env and set OPENAI_API_KEY
```

| Variable | Required | Description | Default |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | OpenAI API key for GPT-4o, embeddings, TTS | — |
| `QDRANT_URL` | Local default | Qdrant vector DB URL | `http://localhost:6333` |
| `REDIS_HOST` | Local default | Redis host | `localhost` |
| `DATABASE_URL` | Local default | PostgreSQL connection string | `postgresql://postgres:postgres@localhost:5432/etnews` |
| `NEO4J_URI` | Local default | Neo4j graph DB URI | `bolt://localhost:7687` |
| `NEO4J_PASSWORD` | Local default | Neo4j password | `password` |
| `KAFKA_BOOTSTRAP_SERVERS` | Local default | Kafka broker address | `localhost:9092` |

All non-API-key values are pre-configured for the local Docker setup in `.env.example`.

---

## 📚 Shared Libraries (`shared/`)

All Python services import from here — no duplicated SDK setup across services.

| Module | Used By | Purpose |
|---|---|---|
| `llm_client.py` | All services | `complete()` (GPT-4o/mini), `complete_stream()` (token-by-token SSE), `embed()` (text-embedding-3-small), `tts()` (tts-1), `transcribe()` (whisper-1) |
| `vector_store.py` | feature-feed, feature-briefing | Qdrant `upsert()` / `search()` with auto collection creation |
| `kafka_client.py` | ingestion-pipeline | `produce()` / `consume()` generator |
| `data/entity_aliases.json` | feature-arc | Canonical entity name map (RBI → Reserve Bank of India, etc.) |
| `data/glossary/hi.json` | feature-vernacular | Hindi financial term glossary injected per translation chunk |

---

## 🏆 Submission

| Item | Status |
|---|---|
| GitHub Repository | Public, source code complete |
| README with setup instructions | This document |
| Commit history showing build process | 55+ commits with feat/fix/test/docs pattern |
| Demo pitch video | [Watch on Google Drive](https://drive.google.com/file/d/1h6-vdI9lkImzxV8cbhiLl6g9z6tVK1_k/view?usp=sharing) |
| Architecture document | ARCHITECTURE.md |
| Impact model | IMPACT_MODEL.md — ₹335 Cr annual impact |

**Team:** Chandrika
**Problem Statement:** PS8 — AI-Native News Experience
**Hackathon:** ET AI Hackathon 2026
