"""
Unified LLM client using OpenAI only.
All services import from here to avoid duplicating SDK setup.

Models in use:
  - gpt-4o            : primary model for generation, briefings, translation, sentiment
  - gpt-4o-mini       : lightweight tasks (classification, short structured outputs)
  - text-embedding-3-small : embeddings
  - tts-1             : audio synthesis
  - whisper-1         : speech-to-text
"""

from __future__ import annotations

import os

import openai

_client: openai.OpenAI | None = None


def get_openai() -> openai.OpenAI:
    global _client
    if _client is None:
        _client = openai.OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    return _client


def complete(
    prompt: str,
    *,
    model: str = "gpt-4o",
    max_tokens: int = 1024,
    system: str | None = None,
) -> str:
    """
    OpenAI chat completion — primary LLM for all generation tasks.
    Use model='gpt-4o-mini' for cheap/simple tasks like classification.
    """
    client = get_openai()
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    resp = client.chat.completions.create(
        model=model,
        max_tokens=max_tokens,
        messages=messages,
    )
    return resp.choices[0].message.content or ""


def complete_stream(
    prompt: str,
    *,
    model: str = "gpt-4o",
    max_tokens: int = 1024,
    system: str | None = None,
):
    """Streaming chat completion — yields text delta chunks as they arrive."""
    client = get_openai()
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    stream = client.chat.completions.create(
        model=model,
        max_tokens=max_tokens,
        messages=messages,
        stream=True,
    )
    for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta


def embed(text: str, model: str = "text-embedding-3-small") -> list[float]:
    """OpenAI embedding — used by ingestion-pipeline and feature-briefing."""
    client = get_openai()
    resp = client.embeddings.create(input=text, model=model)
    return resp.data[0].embedding


def tts(text: str, voice: str = "alloy", model: str = "tts-1") -> bytes:
    """OpenAI TTS — used by feature-video to generate audio."""
    client = get_openai()
    response = client.audio.speech.create(model=model, voice=voice, input=text)
    return response.content


def transcribe(audio_bytes: bytes, filename: str = "audio.mp3") -> str:
    """OpenAI Whisper STT — transcribe audio to text."""
    import io
    client = get_openai()
    audio_file = io.BytesIO(audio_bytes)
    audio_file.name = filename
    transcript = client.audio.transcriptions.create(model="whisper-1", file=audio_file)
    return transcript.text
