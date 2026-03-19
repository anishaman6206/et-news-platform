"""
Qdrant vector store wrapper. Handles collection creation, upsert, and search.
All services that need semantic search import from here.
"""

from __future__ import annotations

import os
import uuid

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    PointStruct,
    VectorParams,
)

EMBEDDING_DIM = 1536  # text-embedding-3-small

_client: QdrantClient | None = None


def get_client() -> QdrantClient:
    global _client
    if _client is None:
        _client = QdrantClient(url=os.environ.get("QDRANT_URL", "http://localhost:6333"))
    return _client


def ensure_collection(name: str, dim: int = EMBEDDING_DIM) -> None:
    client = get_client()
    existing = [c.name for c in client.get_collections().collections]
    if name not in existing:
        client.create_collection(
            collection_name=name,
            vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
        )


def upsert(
    collection: str,
    vector: list[float],
    payload: dict,
    point_id: str | None = None,
) -> str:
    client = get_client()
    ensure_collection(collection)
    pid = point_id or str(uuid.uuid4())
    client.upsert(
        collection_name=collection,
        points=[PointStruct(id=pid, vector=vector, payload=payload)],
    )
    return pid


def search(
    collection: str,
    query_vector: list[float],
    limit: int = 10,
    score_threshold: float = 0.0,
) -> list[dict]:
    client = get_client()
    hits = client.search(
        collection_name=collection,
        query_vector=query_vector,
        limit=limit,
        score_threshold=score_threshold,
        with_payload=True,
    )
    return [{"score": h.score, **h.payload} for h in hits]
