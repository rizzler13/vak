"""
vāk — FastAPI Server

WebSocket endpoint for the voice loop.
HTTP endpoints for health check and text-based testing.
"""

import base64
import json
import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from app.config import settings
from app.llm.llm_router import LLMRouter
from app.voice.stt import get_stt_engine
from app.voice.tts import get_tts_engine
from app.voice.pipeline import VoicePipeline
from app.models.schemas import TextMessage, HealthResponse

# ── Logging ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("vak.server")

# ── Global state (initialized on startup) ──
pipeline: VoicePipeline | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize engines on server start."""
    global pipeline

    logger.info("=" * 50)
    logger.info("vāk — starting up")
    logger.info("=" * 50)

    # Check keys
    keys = settings.validate_keys()
    for name, present in keys.items():
        status = "✓" if present else "✗"
        logger.info(f"  {name}: {status}")

    # Initialize engines
    logger.info("Initializing STT engine...")
    stt = get_stt_engine()
    logger.info(f"  STT: {stt.__class__.__name__}")

    logger.info("Initializing TTS engine...")
    tts = get_tts_engine()
    logger.info(f"  TTS: {tts.__class__.__name__}")

    logger.info("Initializing LLM client...")
    llm = LLMRouter()
    logger.info("  LLM: LLMRouter initialized.")

    # Build pipeline
    pipeline = VoicePipeline(stt_engine=stt, tts_engine=tts, llm_client=llm)
    logger.info("Pipeline ready.")
    logger.info("=" * 50)

    yield  # App runs here

    # Shutdown
    logger.info("vāk — shutting down")


# ── App ──
app = FastAPI(
    title="vāk",
    description="Voice-first thinking partner",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — dynamic configuration from settings
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Health Check ──
@app.get("/health")
async def health():
    engines = {}
    if pipeline:
        engines["stt"] = pipeline._stt.__class__.__name__
        engines["tts"] = pipeline._tts.__class__.__name__
        engines["llm"] = "LLMRouter"
    return HealthResponse(
        status="ok" if pipeline else "not_ready",
        engines=engines,
    )


@app.get("/sessions")
async def get_sessions():
    """List all past shifts."""
    if not pipeline:
        return JSONResponse(status_code=503, content={"detail": "Service not ready"})
    sessions = await pipeline._storage.list_sessions()
    return {"sessions": sessions}


@app.get("/sessions/{session_id}")
async def get_session_details(session_id: str):
    """Load details of a specific shift."""
    if not pipeline:
        return JSONResponse(status_code=503, content={"detail": "Service not ready"})
    try:
        session = await pipeline.get_or_load_session(session_id)
        return {
            "session_id": session_id,
            "history": session.history,
            "insights": session.insights
        }
    except Exception as e:
        logger.error(f"Failed to load session {session_id}: {e}")
        return JSONResponse(status_code=404, content={"detail": f"Session {session_id} not found"})


@app.get("/sessions/{session_id}/report")
async def get_session_report(session_id: str):
    """Fetch cached cognitive focus report or generate one dynamically."""
    if not pipeline:
        return JSONResponse(status_code=503, content={"detail": "Service not ready"})
    try:
        # 1. Try to load cached report from S3
        cached_report = await pipeline._storage.load_report(session_id)
        if cached_report:
            logger.info(f"Loaded cached report for session {session_id} from S3.")
            return cached_report

        # 2. Not cached - generate report from history
        session = await pipeline.get_or_load_session(session_id)
        if not session.history:
            return JSONResponse(
                status_code=400,
                content={"detail": "Cannot generate report for empty session history"}
            )
        
        logger.info(f"Generating new focus report for session {session_id}...")
        report = await pipeline._llm.generate_session_report(session.history)
        
        # 3. Cache it in S3
        await pipeline._storage.save_report(session_id, report)
        
        return report
    except Exception as e:
        logger.error(f"Failed to get report for session {session_id}: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"detail": f"Failed to generate report: {str(e)}"}
        )


# ── WebSocket Voice Endpoint ──
@app.websocket("/ws/voice")
async def voice_websocket(ws: WebSocket, session_id: str | None = None):
    """
    Main voice WebSocket endpoint.

    Protocol:
    1. Client connects
    2. Server sends opening ritual audio (new sessions)
    3. Client sends: {"type": "audio", "data": "<base64 wav>"}
       or:           {"type": "text", "text": "user message"}
    4. Server streams back: {"type": "audio", "data": "<base64 wav>"}
       followed by:         {"type": "done"}
    """
    await ws.accept()
    if not session_id:
        session_id = str(uuid.uuid4())
    logger.info(f"WebSocket connected: session {session_id[:8]}")

    try:
        # Pre-load session and send initial data to client
        session = await pipeline.get_or_load_session(session_id)
        await ws.send_json({
            "type": "session_init",
            "history": session.history,
            "insights": session.insights
        })

        # Define on_meta helper to stream metadata to WebSocket
        async def on_meta(meta: dict):
            try:
                await ws.send_json(meta)
            except Exception as e:
                logger.error(f"Failed to send metadata: {e}")

        # ── Opening Ritual ──
        # vāk speaks first. Always.
        opening_audio = await pipeline.get_opening(session_id)
        if opening_audio:
            opening_text = ""
            for item in session.history:
                if item.get("role") == "assistant":
                    opening_text = item.get("content", "")
                    break
            if opening_text:
                await on_meta({"type": "transcript", "role": "assistant", "text": opening_text})

            await ws.send_json({
                "type": "audio",
                "data": base64.b64encode(opening_audio).decode(),
            })
            await ws.send_json({"type": "done"})

        # ── Conversation Loop ──
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)

            if msg["type"] == "audio":
                # Audio bytes from client
                audio_bytes = base64.b64decode(msg["data"])
                async for chunk in pipeline.process(audio_bytes, session_id, on_meta=on_meta):
                    await ws.send_json({
                        "type": "audio",
                        "data": base64.b64encode(chunk).decode(),
                    })
                await ws.send_json({"type": "done"})

            elif msg["type"] == "text":
                # Text from client (STT done client-side or typed)
                user_text = msg["text"]
                async for chunk in pipeline.process_text(user_text, session_id, on_meta=on_meta):
                    await ws.send_json({
                        "type": "audio",
                        "data": base64.b64encode(chunk).decode(),
                    })
                await ws.send_json({"type": "done"})

            elif msg["type"] == "ping":
                await ws.send_json({"type": "pong"})

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: session {session_id[:8]}")
    except Exception as e:
        logger.error(f"WebSocket error: {e}", exc_info=True)
        try:
            await ws.close()
        except Exception:
            pass


# ── Serve web test client ──
_web_test_dir = Path(__file__).resolve().parent.parent.parent / "web_test"
if _web_test_dir.exists():
    app.mount("/test", StaticFiles(directory=str(_web_test_dir), html=True), name="web_test")
