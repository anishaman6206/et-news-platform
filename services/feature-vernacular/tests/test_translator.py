"""
Unit tests for services/feature-vernacular/main.py

All OpenAI API calls are mocked — no real network requests are made.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_fake_redis() -> MagicMock:
    """Return a MagicMock that behaves like a Redis client with no stored keys."""
    r = MagicMock()
    r.get.return_value = None   # always a cache miss
    r.setex.return_value = True
    return r


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestGlossaryInjection:
    """Glossary terms must be injected into the GPT-4o system prompt."""

    def test_glossary_terms_used(self, mocker: pytest.MonkeyPatch) -> None:
        """
        When 'repo rate' appears in the input chunk, the system prompt passed
        to complete() must contain the Hindi gloss 'रेपो दर'.
        """
        import main

        # Clear in-memory glossary cache so the file is re-read fresh.
        main._glossary_cache.clear()

        mock_complete = mocker.patch("main.complete", return_value="अनुवादित पाठ")

        chunk = "The RBI has kept the repo rate unchanged at 6.5% for the third quarter."
        main.translate_chunk(chunk, "hi")

        assert mock_complete.called, "complete() was never called"
        call_kwargs = mock_complete.call_args
        system: str = call_kwargs.kwargs.get("system", "")
        assert "रेपो दर" in system, (
            f"Expected 'रेपो दर' in system prompt but got:\n{system}"
        )

    def test_irrelevant_glossary_not_injected(self, mocker: pytest.MonkeyPatch) -> None:
        """
        Terms that do NOT appear in the chunk must not appear in the system prompt.
        """
        import main

        main._glossary_cache.clear()

        mock_complete = mocker.patch("main.complete", return_value="अनुवादित पाठ")

        # 'repo rate' is absent from this chunk
        chunk = "The finance minister presented the annual budget today."
        main.translate_chunk(chunk, "hi")

        system: str = mock_complete.call_args.kwargs.get("system", "")
        assert "रेपो दर" not in system


# ---------------------------------------------------------------------------


class TestLengthRatio:
    """check_length_ratio() must compute the ratio and warn when out of range."""

    def test_ratio_equal_length(self) -> None:
        import main

        ratio = main.check_length_ratio("hello world", "नमस्ते दुनिया", "hi")
        # Lengths are similar; ratio should be a positive float
        assert isinstance(ratio, float)
        assert ratio > 0

    def test_ratio_value_is_correct(self) -> None:
        import main

        source = "a" * 100
        translated = "b" * 80   # ratio = 0.80
        ratio = main.check_length_ratio(source, translated, "hi")
        assert abs(ratio - 0.80) < 1e-6

    def test_ratio_in_range_no_warning(self, caplog: pytest.LogCaptureFixture) -> None:
        import main

        source = "word " * 50       # 250 chars
        translated = "शब्द " * 50   # 300 chars — ratio 1.2 (within [0.7, 1.5])
        with caplog.at_level(logging.WARNING, logger="main"):
            main.check_length_ratio(source, translated, "hi")
        assert not any("length ratio" in r.message for r in caplog.records)

    def test_empty_source_returns_one(self) -> None:
        import main

        ratio = main.check_length_ratio("", "कुछ", "hi")
        assert ratio == 1.0


# ---------------------------------------------------------------------------


class TestQualityCheckLogsWarning:
    """A translation that is way too short must trigger a WARNING log."""

    def test_short_translation_logs_warning(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        import main

        source = "The market witnessed significant volatility. " * 20   # ~880 chars
        very_short = "बाजार"   # ~6 chars  →  ratio ≈ 0.007 (far below 0.7)

        with caplog.at_level(logging.WARNING, logger="main"):
            ratio = main.check_length_ratio(source, very_short, "hi")

        assert ratio < 0.7
        warning_messages = [r.message for r in caplog.records if r.levelno == logging.WARNING]
        assert any("length ratio" in msg for msg in warning_messages), (
            f"Expected a 'length ratio' warning. Captured records: {caplog.records}"
        )

    def test_very_long_translation_logs_warning(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        import main

        source = "short"   # 5 chars
        bloated = "अ" * 100   # 100 chars  →  ratio = 20 (above 1.5)

        with caplog.at_level(logging.WARNING, logger="main"):
            ratio = main.check_length_ratio(source, bloated, "hi")

        assert ratio > 1.5
        assert any(
            "length ratio" in r.message
            for r in caplog.records
            if r.levelno == logging.WARNING
        )


# ---------------------------------------------------------------------------


class TestCacheHit:
    """Second call to translate() must not invoke the LLM pipeline."""

    def test_cache_hit_skips_pipeline(
        self, mocker: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """
        After the first translate() call writes to L2 (file cache), the second
        call for the same article_id + lang must be served from file without
        calling run_translation_pipeline() again.
        """
        import main

        # Point L2 cache at a throwaway temp directory
        mocker.patch.object(main, "CACHE_DIR", tmp_path / "translations")

        # Make Redis unavailable so every call falls through to L2
        mocker.patch("main.get_redis", side_effect=ConnectionError("no redis"))

        mock_pipeline = mocker.patch(
            "main.run_translation_pipeline", return_value="नकली अनुवाद"
        )

        text = "India's GDP grew by 7.2% in the last quarter."
        article_id = "art-cache-001"

        result1 = main.translate(text, "hi", article_id)
        result2 = main.translate(text, "hi", article_id)

        assert result1 == result2 == "नकली अनुवाद"
        assert mock_pipeline.call_count == 1, (
            f"Pipeline called {mock_pipeline.call_count} times; expected 1 (L2 hit on second call)"
        )

    def test_redis_l1_hit_skips_pipeline(
        self, mocker: pytest.MonkeyPatch
    ) -> None:
        """L1 (Redis) hit must also prevent the pipeline from running."""
        import main

        fake_redis = _make_fake_redis()
        fake_redis.get.return_value = "cached Hindi text"   # L1 hit
        mocker.patch("main.get_redis", return_value=fake_redis)

        mock_pipeline = mocker.patch("main.run_translation_pipeline")

        result = main.translate("Some text", "hi", "art-redis-001")

        assert result == "cached Hindi text"
        mock_pipeline.assert_not_called()


# ---------------------------------------------------------------------------


class TestHealthEndpoint:
    """GET /health must return 200 with the expected payload."""

    def test_health_returns_200(self) -> None:
        import main

        client = TestClient(main.app)
        resp = client.get("/health")

        assert resp.status_code == 200
        assert resp.json() == {"status": "ok", "service": "vernacular"}


# ---------------------------------------------------------------------------


class TestChunking:
    """chunk_text() must respect paragraph boundaries and the token limit."""

    def test_single_short_paragraph(self) -> None:
        import main

        text = "Short paragraph."
        chunks = main.chunk_text(text)
        assert chunks == ["Short paragraph."]

    def test_splits_at_paragraph_boundary(self) -> None:
        import main

        # Each paragraph is ~100 chars; token limit 800 tokens = 3200 chars,
        # so they should all fit in one chunk.
        para = "word " * 20 + "."   # ~101 chars
        text = "\n\n".join([para] * 3)
        chunks = main.chunk_text(text)
        assert len(chunks) == 1

    def test_large_text_produces_multiple_chunks(self) -> None:
        import main

        # 40 paragraphs of 200 chars each = 8000 chars total
        # CHUNK_TOKEN_LIMIT=800 → char_limit=3200 → should split into 3+ chunks
        para = "x " * 99 + "."   # ≈ 200 chars
        text = "\n\n".join([para] * 40)
        chunks = main.chunk_text(text, token_limit=800)
        assert len(chunks) > 1


# ---------------------------------------------------------------------------


class TestTranslateEndpoint:
    """GET /translate and POST /translate/batch must validate lang and return data."""

    def test_unsupported_language_returns_422(self) -> None:
        import main

        client = TestClient(main.app)
        resp = client.get(
            "/translate",
            params={"article_id": "x", "text": "hello", "lang": "xx"},
        )
        assert resp.status_code == 422

    def test_batch_unsupported_language_returns_422(self) -> None:
        import main

        client = TestClient(main.app)
        resp = client.post(
            "/translate/batch",
            json={"articles": [{"id": "1", "text": "hello"}], "lang": "zz"},
        )
        assert resp.status_code == 422

    def test_translate_calls_pipeline(
        self, mocker: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        import main

        mocker.patch.object(main, "CACHE_DIR", tmp_path / "translations")
        mocker.patch("main.get_redis", side_effect=ConnectionError("no redis"))
        mocker.patch("main.run_translation_pipeline", return_value="हिंदी पाठ")

        client = TestClient(main.app)
        resp = client.get(
            "/translate",
            params={"article_id": "a1", "text": "India GDP grew.", "lang": "hi"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["translated"] == "हिंदी पाठ"
        assert data["article_id"] == "a1"
        assert data["lang"] == "hi"
