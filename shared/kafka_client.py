"""
Kafka producer/consumer helpers. Services import produce() and consume() from here.
"""

from __future__ import annotations

import json
import os
from collections.abc import Generator
from typing import Any

from kafka import KafkaConsumer, KafkaProducer

_producer: KafkaProducer | None = None


def _bootstrap() -> list[str]:
    return os.environ.get("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092").split(",")


def get_producer() -> KafkaProducer:
    global _producer
    if _producer is None:
        _producer = KafkaProducer(
            bootstrap_servers=_bootstrap(),
            value_serializer=lambda v: json.dumps(v).encode("utf-8"),
            key_serializer=lambda k: k.encode("utf-8") if k else None,
        )
    return _producer


def produce(topic: str, value: dict[str, Any], key: str | None = None) -> None:
    get_producer().send(topic, value=value, key=key)


def consume(
    topic: str,
    group_id: str,
    auto_offset_reset: str = "earliest",
) -> Generator[dict[str, Any], None, None]:
    consumer = KafkaConsumer(
        topic,
        bootstrap_servers=_bootstrap(),
        group_id=group_id,
        value_deserializer=lambda m: json.loads(m.decode("utf-8")),
        auto_offset_reset=auto_offset_reset,
        enable_auto_commit=True,
    )
    for msg in consumer:
        yield msg.value
