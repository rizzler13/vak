"""
vāk — Configuration
Loads settings from .env at project root.
"""

from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


# Resolve .env from project root (two levels up from this file)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_ENV_FILE = _PROJECT_ROOT / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- API Keys ---
    groq_api_key: str = ""
    deepgram_api_key: str = ""
    cartesia_api_key: str = ""
    cerebras_api_key: str = ""
    openrouter_api_key: str = ""

    # --- STT ---
    use_local_stt: bool = False  # Deepgram by default (faster)
    whisper_model: str = "base"  # base, small, medium for mlx-whisper

    # --- TTS ---
    use_local_tts: bool = True  # Kokoro by default (free)
    kokoro_voice: str = "af_heart"  # Kokoro voice preset
    cartesia_voice_id: str = "a0e99841-438c-4a64-b679-ae501e7d6091"  # Cartesia voice
    cartesia_model_id: str = "sonic"

    # --- LLM ---
    groq_model: str = "llama-3.3-70b-versatile"
    cerebras_model: str = "llama3.1-8b"
    openrouter_model: str = "google/gemini-2.5-flash"

    # --- Server ---
    host: str = "0.0.0.0"
    port: int = 8000

    # --- AWS S3 ---
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    aws_region: str = "us-east-1"
    aws_s3_bucket: str = "vak-session-history"
    aws_s3_prefix: str = "vak/"

    def validate_keys(self) -> dict[str, bool]:
        """Check which API keys are configured."""
        return {
            "groq": bool(self.groq_api_key),
            "deepgram": bool(self.deepgram_api_key),
            "cartesia": bool(self.cartesia_api_key),
            "cerebras": bool(self.cerebras_api_key),
            "openrouter": bool(self.openrouter_api_key),
            "aws": bool(self.aws_access_key_id and self.aws_secret_access_key),
        }


# Singleton
settings = Settings()
