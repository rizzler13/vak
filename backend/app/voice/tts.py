"""
vāk — Text-to-Speech Engines

Two engines:
1. KokoroTTS — local, offline, ~82MB model, runs on CPU. Free.
2. CartesiaTTS — streaming API, lower latency, costs money.

Both produce WAV audio bytes.
"""

import io
import os
import time
import logging
from abc import ABC, abstractmethod
from pathlib import Path

import numpy as np
import soundfile as sf

from app.config import settings

logger = logging.getLogger("vak.tts")

# Cache directory for model files
_CACHE_DIR = Path.home() / ".cache" / "vak"


class TTSEngine(ABC):
    """Base class for TTS engines."""

    @abstractmethod
    async def synthesize(self, text: str) -> bytes:
        """Convert text to WAV audio bytes."""
        ...


class KokoroTTS(TTSEngine):
    """
    Kokoro TTS — local, offline, free.
    82M params, runs on CPU, sounds surprisingly good.
    Model files auto-download on first use (~82MB).
    """

    def __init__(self):
        from kokoro_onnx import Kokoro

        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        model_path = _CACHE_DIR / "kokoro-v1.0.onnx"
        voices_path = _CACHE_DIR / "voices-v1.0.bin"

        logger.info("Loading Kokoro TTS model...")
        t_start = time.perf_counter()

        # If files don't exist locally, let Kokoro try auto-download
        # or download from HuggingFace
        if not model_path.exists() or not voices_path.exists():
            logger.info("Model files not found, downloading (~82MB)...")
            self._download_models(model_path, voices_path)

        self._kokoro = Kokoro(str(model_path), str(voices_path))
        self._voice = settings.kokoro_voice

        elapsed = time.perf_counter() - t_start
        logger.info(f"Kokoro TTS loaded in {elapsed:.1f}s (voice: {self._voice})")

    def _download_models(self, model_path: Path, voices_path: Path):
        """Download model files from GitHub releases."""
        import ssl
        import urllib.request

        # Handle SSL certificate verification
        try:
            import certifi
            ssl_context = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            ssl_context = ssl.create_default_context()

        base_url = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

        for filename, path in [
            ("kokoro-v1.0.onnx", model_path),
            ("voices-v1.0.bin", voices_path),
        ]:
            if not path.exists():
                url = f"{base_url}/{filename}"
                logger.info(f"  Downloading {filename}...")
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, context=ssl_context) as resp:
                    with open(path, "wb") as f:
                        while True:
                            chunk = resp.read(8192)
                            if not chunk:
                                break
                            f.write(chunk)
                logger.info(f"  Saved to {path}")

    async def synthesize(self, text: str) -> bytes:
        """Synthesize text to WAV bytes."""
        t_start = time.perf_counter()

        # Kokoro returns (samples, sample_rate)
        samples, sample_rate = self._kokoro.create(
            text, voice=self._voice, speed=1.0, lang="en-us"
        )

        # Convert to WAV bytes
        wav_buffer = io.BytesIO()
        sf.write(wav_buffer, samples, sample_rate, format="WAV", subtype="PCM_16")
        wav_bytes = wav_buffer.getvalue()

        elapsed = (time.perf_counter() - t_start) * 1000
        logger.info(f"Kokoro TTS: {elapsed:.0f}ms for {len(text)} chars")

        return wav_bytes


class CartesiaTTS(TTSEngine):
    """
    Cartesia Sonic TTS — streaming API.
    Lower latency than local for sentence-level chunks.
    """

    def __init__(self):
        if not settings.cartesia_api_key:
            raise ValueError("CARTESIA_API_KEY not set.")

        from cartesia import AsyncCartesia

        self._client = AsyncCartesia(api_key=settings.cartesia_api_key)
        self._voice_id = settings.cartesia_voice_id
        self._model_id = settings.cartesia_model_id

    async def synthesize(self, text: str) -> bytes:
        """Synthesize text via Cartesia API, return WAV bytes."""
        t_start = time.perf_counter()

        audio_data = await self._client.tts.bytes(
            model_id=self._model_id,
            transcript=text,
            voice_id=self._voice_id,
            output_format={
                "container": "wav",
                "encoding": "pcm_s16le",
                "sample_rate": 24000,
            },
        )

        elapsed = (time.perf_counter() - t_start) * 1000
        logger.info(f"Cartesia TTS: {elapsed:.0f}ms for {len(text)} chars")

        return audio_data


def get_tts_engine() -> TTSEngine:
    """Factory: return the appropriate TTS engine based on config."""
    if settings.use_local_tts:
        try:
            return KokoroTTS()
        except Exception as e:
            logger.warning(f"KokoroTTS failed ({e}), trying Cartesia")

    if settings.cartesia_api_key:
        return CartesiaTTS()

    # Fallback to local
    return KokoroTTS()
