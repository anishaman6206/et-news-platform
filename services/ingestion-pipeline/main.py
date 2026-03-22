"""
Kafka consumer that ingests ET articles, embeds them via
OpenAI text-embedding-3-small, and stores in Qdrant.
In the hackathon demo, feature-feed seeds Qdrant directly
on startup. This service handles production-scale ingestion.

Topic flow:
  raw-articles  →  [embed + upsert Qdrant]  →  processed-articles

How it works:
  1. Consume messages from Kafka topic `raw-articles`
  2. Concatenate title + content, call embed() for a 1536-d vector
  3. Upsert into Qdrant `articles` collection with full payload
  4. Publish to `processed-articles` for downstream consumers
     (feature-arc, feature-video, feature-vernacular)
"""

import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

RAW_TOPIC       = os.environ.get("KAFKA_TOPIC_RAW_ARTICLES",       "raw-articles")
PROCESSED_TOPIC = os.environ.get("KAFKA_TOPIC_PROCESSED_ARTICLES", "processed-articles")
COLLECTION      = "articles"


def process_article(article: dict) -> None:
    """
    Full ingestion pipeline for one article.

    Steps:
      1. Build text: title + content
      2. embed()               → 1536-d vector via text-embedding-3-small
      3. vector_store.upsert() → Qdrant `articles` collection
      4. kafka_client.produce()→ processed-articles topic for downstream consumers
    """
    # Lazy imports so unit tests can mock without starting Kafka/Qdrant
    import vector_store
    import kafka_client
    from llm_client import embed

    text   = f"{article.get('title', '')} {article.get('content', '')}"
    vector = embed(text)

    vector_store.upsert(
        collection=COLLECTION,
        vector=vector,
        payload={
            "article_id":   article["id"],
            "title":        article.get("title"),
            "section":      article.get("section"),
            "source":       article.get("source"),
            "url":          article.get("url"),
            "published_at": article.get("published_at"),
        },
        point_id=str(article["id"]),
    )

    kafka_client.produce(PROCESSED_TOPIC, {**article, "embedded": True})
    log.info("Ingested article id=%s title=%r", article.get("id"), article.get("title"))


def main() -> None:
    """
    Main Kafka consumer loop.

    In production this runs as a long-lived process consuming
    from `raw-articles`. For the hackathon demo, feature-feed
    seeds Qdrant directly via vector_store.upsert() on startup
    so this service is not required.
    """
    import vector_store
    import kafka_client

    log.info("Ingestion pipeline starting — consuming from '%s'", RAW_TOPIC)

    # Ensure the Qdrant collection exists before consuming
    vector_store.ensure_collection(COLLECTION)

    for article in kafka_client.consume(RAW_TOPIC, group_id="ingestion-pipeline"):
        try:
            process_article(article)
        except Exception as exc:
            log.exception("Failed to process article id=%s: %s", article.get("id"), exc)


if __name__ == "__main__":
    main()
