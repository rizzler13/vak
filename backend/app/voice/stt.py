"""
vāk — Speech-to-Text Engines

Two engines:
1. DeepgramSTT — fast, production-quality (uses API key, Deepgram SDK v7)
2. LocalSTT — uses system-installed mlx-whisper via subprocess (free, offline)
"""

import io
import json
import time
import logging
import tempfile
import subprocess
from abc import ABC, abstractmethod
from pathlib import Path

from app.config import settings

logger = logging.getLogger("vak.stt")


class STTEngine(ABC):
    """Base class for STT engines."""

    @abstractmethod
    async def transcribe(self, audio_bytes: bytes) -> str:
        """Transcribe audio bytes to text."""
        ...


class DeepgramSTT(STTEngine):
    """
    Deepgram Nova-2 STT via SDK v7.
    Uses pre-recorded (file) endpoint for Sprint 1.
    """

    def __init__(self):
        if not settings.deepgram_api_key:
            raise ValueError("DEEPGRAM_API_KEY not set.")

        from deepgram import AsyncDeepgramClient

        self._client = AsyncDeepgramClient(api_key=settings.deepgram_api_key)

    async def transcribe(self, audio_bytes: bytes) -> str:
        t_start = time.perf_counter()

        response = await self._client.listen.v1.media.transcribe_file(
            request=audio_bytes,
            model="nova-2",
            language="en",
            smart_format=True,
            punctuate=True,
        )

        # Extract transcript from response
        transcript_text = ""
        if response and response.results and response.results.channels:
            channel = response.results.channels[0]
            if channel.alternatives:
                transcript_text = channel.alternatives[0].transcript

        elapsed = (time.perf_counter() - t_start) * 1000
        logger.info(f"Deepgram STT: {elapsed:.0f}ms — '{transcript_text[:80]}'")

        return transcript_text


class LocalSTT(STTEngine):
    """
    Local STT using system-installed mlx-whisper.
    Runs as subprocess because mlx-whisper requires Python <3.13.
    Falls back gracefully if not available.
    """

    def __init__(self):
        self._model = settings.whisper_model
        # Verify mlx_whisper is available in system python
        try:
            result = subprocess.run(
                ["python3", "-c", "import mlx_whisper"],
                capture_output=True,
                timeout=10,
            )
            if result.returncode != 0:
                raise RuntimeError("mlx_whisper not available in system Python")
            logger.info("LocalSTT: mlx-whisper available via system Python")
        except Exception as e:
            raise RuntimeError(f"Cannot initialize LocalSTT: {e}")

    async def transcribe(self, audio_bytes: bytes) -> str:
        t_start = time.perf_counter()

        # Write audio to temp file
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name

        try:
            # Run mlx_whisper via system python — path passed as argument to avoid injection
            script = f"""
import json, sys, mlx_whisper
result = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo="mlx-community/whisper-{self._model}-mlx")
print(json.dumps({{"text": result["text"]}}))
"""
            result = subprocess.run(
                ["python3", "-c", script, tmp_path],
                capture_output=True,
                text=True,
                timeout=30,
            )

            if result.returncode != 0:
                logger.error(f"LocalSTT error: {result.stderr}")
                return ""

            data = json.loads(result.stdout.strip())
            transcript_text = data["text"].strip()

            elapsed = (time.perf_counter() - t_start) * 1000
            logger.info(f"LocalSTT: {elapsed:.0f}ms — '{transcript_text[:80]}'")

            return transcript_text

        finally:
            Path(tmp_path).unlink(missing_ok=True)


def get_stt_engine() -> STTEngine:
    """Factory: return the appropriate STT engine based on config."""
    if settings.use_local_stt:
        try:
            return LocalSTT()
        except RuntimeError as e:
            logger.warning(f"LocalSTT unavailable ({e}), falling back to Deepgram")

    if settings.deepgram_api_key:
        return DeepgramSTT()

    # Last resort: try local anyway
    return LocalSTT()
