"""
Production API gateway — handles auth, rate limiting,
and routes requests to microservices. Not required for
hackathon demo (frontend calls services directly).

Planned responsibilities:
  - JWT authentication + session management
  - Per-user rate limiting (Redis token bucket)
  - Routes POST /articles  → ingestion-pipeline (Kafka)
  - Routes GET  /user      → feature-feed
  - Routes GET  /briefing  → feature-briefing
  - Routes GET  /arc       → feature-arc
  - Routes POST /video     → feature-video
  - Routes GET  /translate → feature-vernacular
"""

import os

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="ET News API Gateway",
    version="0.1.0",
    description="Production gateway — not required for hackathon demo.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "api-server"}


@app.post("/articles")
async def ingest_article(body: dict) -> dict:
    """
    TODO (production): validate payload, publish to Kafka `raw-articles` topic.
    The ingestion-pipeline consumer will embed and store in Qdrant.
    """
    return {"status": "not_implemented", "note": "demo uses direct service calls"}


@app.get("/user")
async def get_user(user_id: str) -> dict:
    """
    TODO (production): authenticate JWT, then proxy to feature-feed /feed/{user_id}.
    Returns personalised article rankings for the authenticated user.
    """
    return {"status": "not_implemented", "note": "demo uses direct service calls"}


@app.get("/briefing")
async def get_briefing(topic: str) -> dict:
    """
    TODO (production): authenticate JWT, proxy to feature-briefing /briefing/generate.
    Streams SSE back to the client after auth check and rate-limit enforcement.
    """
    return {"status": "not_implemented", "note": "demo uses direct service calls"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("API_SERVER_PORT", 8000)),
        reload=True,
    )
