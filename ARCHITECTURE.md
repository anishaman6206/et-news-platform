# ET AI News Platform — Architecture

**PS8 submission — ET AI Hackathon 2026**

---

## System Overview

The ET AI News Platform is an AI-native microservices system built for Economic Times, delivering personalisation, multilingual access, intelligent briefings, story tracking, and AI-generated video to ET readers. Five independently deployable services share a common infrastructure layer (Qdrant, Redis, Neo4j, PostgreSQL, Kafka) and route all LLM calls through a single shared client (`shared/llm_client.py`) backed by the OpenAI API. GPT-4o is the primary intelligence layer across every feature — handling translation, ranking, briefing synthesis, sentiment scoring, and video script generation — with OpenAI TTS for audio and `text-embedding-3-small` for semantic search.

---

## Full System Architecture

```mermaid
flowchart TD
  User([User / Client])

  subgraph Services
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
    LLM[llm_client.py\ncomplete · embed · tts]
    VS[vector_store.py\nupsert · search]
    KC[kafka_client.py\nproduce · consume]
  end

  OpenAI([OpenAI API\nGPT-4o · TTS · Embeddings])

  Ingestion[ingestion-pipeline\nKafka consumer]

  User -->|GET /translate| V
  User -->|GET /feed · POST /onboard · POST /engage| F
  User -->|POST /briefing/generate · /ask| B
  User -->|POST /arc/process · GET /arc/topic| A
  User -->|POST /video/generate · GET /video/status| VD

  V --> Redis
  F --> Redis
  F --> Qdrant
  B --> Redis
  B --> Qdrant
  A --> Neo4j
  A --> Postgres
  VD -.->|optional| Kafka

  Kafka --> Ingestion
  Ingestion --> Qdrant
  Ingestion --> Kafka

  V --> LLM
  F --> LLM
  F --> VS
  B --> LLM
  B --> VS
  A --> LLM
  VD --> LLM

  VS --> Qdrant
  KC --> Kafka

  LLM --> OpenAI
```

---

## Service Table

| Service | Port | Key Technologies | Purpose |
|---|---|---|---|
| `feature-vernacular` | 8005 | GPT-4o, Redis (L1+L2 cache) | EN → 8 Indian language translation with financial glossary |
| `feature-feed` | 8011 | Qdrant, Redis, OpenAI Embeddings | Personalised article ranking via semantic similarity + EMA |
| `feature-briefing` | 8002 | Qdrant, Redis, GPT-4o | RAG briefings with RRF retrieval, dedup, SSE streaming |
| `feature-arc` | 8004 | spaCy, Neo4j, PostgreSQL, GPT-4o-mini | NER → entity graph → sentiment timeline → AI predictions |
| `feature-video` | 8003 | GPT-4o, OpenAI TTS, FFmpeg, Pillow | Scene manifest → TTS audio → Pillow frames → MP4 |

---

## Data Flow Per Feature

| Feature | Pipeline |
|---|---|
| **Vernacular** | Article text → chunk (800 tokens) → GPT-4o + glossary injection → quality check → Redis + file cache → translated article |
| **Feed** | User signal → EMA vector update (α=0.15) → Qdrant ANN (top 200) → rerank (cosine + recency + diversity) → top 20 articles |
| **Briefing** | Topic query → RRF merge (semantic + keyword search) → Jaccard dedup (0.60) → GPT-4o → structured JSON + source citations + SSE |
| **Arc** | Article → spaCy NER + alias resolution → Neo4j MERGE (Entity + CO_OCCURS) + GPT-4o-mini sentiment → PostgreSQL → GPT-4o predictions |
| **Video** | Article → GPT-4o scene manifest → OpenAI TTS per scene + Pillow PNG frames → pydub concat → FFmpeg filter_complex → MP4 |

---

## Error Handling

- **`_parse_json()`** — strips GPT-4o markdown fences (`\`\`\`json`) before `json.loads`; used in both `feature-arc` and `feature-video` to handle inconsistent LLM output formatting
- **3-layer cache** — Redis L1 (hot, TTL-bounded) → file/DB L2 (warm, persistent) → live pipeline (cold); implemented in `feature-vernacular` and `feature-briefing`
- **FFmpeg detection** — `check_ffmpeg()` runs at startup via FastAPI lifespan; `GET /health` reports `ffmpeg_available: true/false` so the frontend can disable video generation gracefully
- **Frame render guard** — `feature-video` logs frame failures with full traceback and returns `status=failed` with a descriptive error if all frames fail, preventing silent empty-video output
- **Entity normalisation** — `feature-arc` strips leading "The/the" from ORG entities and resolves aliases before Neo4j writes, preventing duplicate nodes (`"The Reserve Bank of India"` → `"Reserve Bank of India"`)
- **All services** expose `GET /health` for liveness probing and container orchestration readiness checks

---

## Shared Utilities (`shared/`)

| Module | Used by | Purpose |
|---|---|---|
| `llm_client.py` | All services | `complete()` (GPT-4o/mini), `embed()` (text-embedding-3-small), `tts()` (tts-1), `transcribe()` (whisper-1) |
| `vector_store.py` | feature-feed, feature-briefing | Qdrant `upsert()` / `search()` with auto collection creation |
| `kafka_client.py` | ingestion-pipeline | `produce()` / `consume()` generator |
| `data/entity_aliases.json` | feature-arc | Canonical entity name map (RBI → Reserve Bank of India, etc.) |
| `data/glossary/hi.json` | feature-vernacular | Hindi financial term glossary injected per chunk |

---

## Infrastructure

| Service | Port | Purpose |
|---|---|---|
| PostgreSQL | 5432 | Sentiment records (`article_sentiments` table) |
| Redis | 6379 | Translation cache (TTL 24h), briefing cache (TTL 6h), user vectors |
| Qdrant | 6333 | Article embedding vectors for semantic search and feed ranking |
| Neo4j | 7474 / 7687 | Entity knowledge graph (Entity nodes + CO_OCCURS edges) |
| Kafka | 9092 | Raw article ingestion event bus |

All infrastructure is declared in `docker-compose.yml` and starts with:

```bash
docker compose up qdrant neo4j redis kafka postgres -d
```
