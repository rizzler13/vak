"""
vāk — Voice Pipeline

The heart of Sprint 1.
Audio in → STT → LLM (streaming) → TTS (sentence-by-sentence) → Audio out.

Each sentence is synthesized as soon as it's complete from the LLM,
giving us audio output while the model is still generating.
"""

import time
import logging
import asyncio
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field

from app.llm.llm_router import LLMRouter
from app.llm.prompts import build_messages, get_opening_prompt
from app.voice.stt import STTEngine
from app.voice.tts import TTSEngine
from app.storage.s3 import S3HistoryStore

logger = logging.getLogger("vak.pipeline")


@dataclass
class PipelineMetrics:
    """Timing metrics for a single pipeline run."""

    stt_ms: float = 0.0
    llm_first_token_ms: float = 0.0
    tts_first_chunk_ms: float = 0.0
    total_first_audio_ms: float = 0.0
    sentences_generated: int = 0

    def log(self):
        logger.info(
            f"Pipeline metrics — "
            f"STT: {self.stt_ms:.0f}ms | "
            f"LLM→first token: {self.llm_first_token_ms:.0f}ms | "
            f"TTS→first chunk: {self.tts_first_chunk_ms:.0f}ms | "
            f"Total→first audio: {self.total_first_audio_ms:.0f}ms | "
            f"Sentences: {self.sentences_generated}"
        )


@dataclass
class SessionState:
    """Holds conversation state for a single session."""

    history: list[dict] = field(default_factory=list)
    is_new_session: bool = True
    insights: dict = field(default_factory=dict)
    title: str = ""

    def add_exchange(self, user_text: str, assistant_text: str):
        """Add a user/assistant exchange to history."""
        self.history.append({"role": "user", "content": user_text})
        self.history.append({"role": "assistant", "content": assistant_text})
        self.is_new_session = False

    def get_recent_history(self, max_turns: int = 10) -> list[dict]:
        """Get recent history, keeping it bounded."""
        # Each turn = 2 messages (user + assistant)
        max_messages = max_turns * 2
        return self.history[-max_messages:]


class VoicePipeline:
    """
    Orchestrates the full voice loop:
    audio bytes → text → LLM response → audio bytes

    Streams audio chunks back as soon as each sentence is ready.
    """

    def __init__(
        self,
        stt_engine: STTEngine,
        tts_engine: TTSEngine,
        llm_client: LLMRouter,
    ):
        self._stt = stt_engine
        self._tts = tts_engine
        self._llm = llm_client
        self._sessions: dict[str, SessionState] = {}
        self._storage = S3HistoryStore()

    async def get_or_load_session(self, session_id: str) -> SessionState:
        """Get the session from memory, or load it from storage if not in memory."""
        if session_id not in self._sessions:
            history = await self._storage.load_history(session_id)
            user_id = "default"
            insights = await self._storage.load_insights(user_id)
            
            # Find the title from the listed sessions
            title = ""
            try:
                sessions = await self._storage.list_sessions()
                for s in sessions:
                    if s["session_id"] == session_id:
                        title = s.get("title", "")
                        break
            except Exception:
                pass
            
            is_new = len(history) == 0
            self._sessions[session_id] = SessionState(
                history=history, 
                is_new_session=is_new,
                insights=insights,
                title=title or (f"Shift {session_id[:6].upper()}" if not is_new else "Seeking Clarity")
            )
        return self._sessions[session_id]

    async def get_opening(self, session_id: str) -> bytes:
        """
        Generate the opening ritual audio.
        vāk speaks first. Always.
        """
        session = await self.get_or_load_session(session_id)
        if not session.is_new_session:
            return b""

        opening_text = get_opening_prompt()
        logger.info(f"Opening ritual: '{opening_text}'")

        audio = await self._tts.synthesize(opening_text)

        # Store in history so the LLM knows what vāk said
        session.history.append({"role": "assistant", "content": opening_text})
        asyncio.create_task(self._storage.save_history(session_id, session.history, session.title))

        return audio

    async def _update_insights_background(
        self, user_id: str, history: list[dict], session: SessionState, on_meta=None
    ):
        """Asynchronously analyze conversation, generate new insights, and save to S3."""
        try:
            new_insights = await self._llm.generate_insights(history, session.insights)
            if new_insights:
                session.insights = new_insights
                await self._storage.save_insights(user_id, new_insights)
                if on_meta:
                    await on_meta({"type": "insights", "data": new_insights})
        except Exception as e:
            logger.error(f"Failed to update insights in background: {e}", exc_info=True)

    async def process(
        self, audio_bytes: bytes, session_id: str = "default", on_meta=None
    ) -> AsyncGenerator[bytes, None]:
        """
        Full pipeline: audio in → audio chunks out.

        Yields WAV audio bytes for each sentence as it's generated.
        """
        t_pipeline_start = time.perf_counter()
        metrics = PipelineMetrics()
        session = await self.get_or_load_session(session_id)

        # ── Step 1: STT ──
        t_stt_start = time.perf_counter()
        user_text = await self._stt.transcribe(audio_bytes)
        metrics.stt_ms = (time.perf_counter() - t_stt_start) * 1000

        if not user_text.strip():
            logger.warning("STT returned empty text, skipping")
            return

        logger.info(f"User said: '{user_text}'")
        if on_meta:
            await on_meta({"type": "transcript", "role": "user", "text": user_text})

        # ── Step 2: Build messages with insights injected ──
        messages = build_messages(
            user_text=user_text,
            history=session.get_recent_history(),
            insights=session.insights,
        )

        # ── Step 3: Stream LLM → TTS sentence by sentence ──
        full_response = ""
        first_audio = True

        async for sentence in self._llm.stream_sentences(messages):
            if first_audio:
                metrics.llm_first_token_ms = (
                    time.perf_counter() - t_pipeline_start
                ) * 1000 - metrics.stt_ms

            # Synthesize this sentence
            t_tts = time.perf_counter()
            audio_chunk = await self._tts.synthesize(sentence)
            tts_ms = (time.perf_counter() - t_tts) * 1000

            if first_audio:
                metrics.tts_first_chunk_ms = tts_ms
                metrics.total_first_audio_ms = (
                    time.perf_counter() - t_pipeline_start
                ) * 1000
                first_audio = False

            full_response += sentence + " "
            metrics.sentences_generated += 1

            if on_meta:
                await on_meta({"type": "transcript", "role": "assistant", "text": sentence})

            yield audio_chunk

        # ── Step 4: Update session history and save ──
        session.add_exchange(user_text, full_response.strip())
        
        # Generate dynamic cool name/title in background if not already customized
        if not session.title or session.title == "Seeking Clarity" or session.title.startswith("Shift "):
            try:
                title = await self._llm.generate_session_title(session.history)
                session.title = title
            except Exception as e:
                logger.error(f"Failed to generate session title: {e}")
                session.title = f"Shift {session_id[:6].upper()}"
                
        asyncio.create_task(self._storage.save_history(session_id, session.history, session.title))
        
        # Trigger background synthesis of insights
        asyncio.create_task(self._update_insights_background("default", session.history, session, on_meta))

        # ── Log metrics ──
        metrics.log()
        if on_meta:
            await on_meta({
                "type": "metrics",
                "stt_ms": metrics.stt_ms,
                "llm_ms": metrics.llm_first_token_ms,
                "tts_ms": metrics.tts_first_chunk_ms,
            })

    async def process_text(
        self, user_text: str, session_id: str = "default", on_meta=None
    ) -> AsyncGenerator[bytes, None]:
        """
        Text-only pipeline (skip STT).
        Useful for the web test client that does STT in the browser.
        """
        t_start = time.perf_counter()
        metrics = PipelineMetrics()
        session = await self.get_or_load_session(session_id)

        logger.info(f"User text: '{user_text}'")
        if on_meta:
            await on_meta({"type": "transcript", "role": "user", "text": user_text})

        messages = build_messages(
            user_text=user_text,
            history=session.get_recent_history(),
            insights=session.insights,
        )

        full_response = ""
        first_audio = True

        async for sentence in self._llm.stream_sentences(messages):
            if first_audio:
                metrics.llm_first_token_ms = (time.perf_counter() - t_start) * 1000

            t_tts = time.perf_counter()
            audio_chunk = await self._tts.synthesize(sentence)
            tts_ms = (time.perf_counter() - t_tts) * 1000

            if first_audio:
                metrics.total_first_audio_ms = (
                    time.perf_counter() - t_start
                ) * 1000
                metrics.tts_first_chunk_ms = tts_ms
                first_audio = False

            full_response += sentence + " "
            metrics.sentences_generated += 1

            if on_meta:
                await on_meta({"type": "transcript", "role": "assistant", "text": sentence})

            yield audio_chunk

        session.add_exchange(user_text, full_response.strip())
        
        # Generate dynamic cool name/title in background if not already customized
        if not session.title or session.title == "Seeking Clarity" or session.title.startswith("Shift "):
            try:
                title = await self._llm.generate_session_title(session.history)
                session.title = title
            except Exception as e:
                logger.error(f"Failed to generate session title: {e}")
                session.title = f"Shift {session_id[:6].upper()}"
                
        asyncio.create_task(self._storage.save_history(session_id, session.history, session.title))
        
        # Trigger background synthesis of insights
        asyncio.create_task(self._update_insights_background("default", session.history, session, on_meta))
        
        metrics.log()
        if on_meta:
            await on_meta({
                "type": "metrics",
                "stt_ms": 0.0,
                "llm_ms": metrics.llm_first_token_ms,
                "tts_ms": metrics.tts_first_chunk_ms,
            })
