"""
vāk — FastAPI Server

WebSocket endpoint for the voice loop.
HTTP endpoints for health check and text-based testing.
"""

import base64
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

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

# CORS — allow all local, staging, and CloudFront origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins + ["null", "*"],
    allow_origin_regex=r"^https?://.*$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Root Redirect ──
@app.get("/")
async def root():
    return RedirectResponse(url="/test/")


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
async def get_sessions(uid: str | None = None):
    """List all past shifts (optionally scoped to uid)."""
    if not pipeline:
        return JSONResponse(status_code=503, content={"detail": "Service not ready"})
    sessions = await pipeline._storage.list_sessions(user_id=uid)
    return {"sessions": sessions}


@app.get("/sessions/auth-config")
async def get_auth_config():
    """Deliver public Firebase client config without committing API key in git."""
    return {
        "projectId": settings.firebase_project_id,
        "appId": settings.firebase_app_id,
        "storageBucket": settings.firebase_storage_bucket,
        "apiKey": settings.firebase_api_key,
        "authDomain": settings.firebase_auth_domain,
        "messagingSenderId": settings.firebase_messaging_sender_id,
        "measurementId": settings.firebase_measurement_id,
    }


class ProxyTestRequest(BaseModel):
    url: str
    method: str = "GET"
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | None = None


@app.post("/sessions/proxy-test")
@app.post("/proxy-test")
async def proxy_test_endpoint(req: ProxyTestRequest):
    """
    Server-side proxy for the In-Browser API Tester.
    Bypasses browser CORS restrictions and safely validates remote endpoints.
    """
    url = req.url.strip()
    if not url:
        return JSONResponse(status_code=400, content={
            "ok": False,
            "status": 400,
            "error_type": "EMPTY_URL",
            "message": "Target URL cannot be empty.",
            "proxied": True
        })

    if not (url.startswith("http://") or url.startswith("https://")):
        url = "https://" + url

    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower()

    # Block internal metadata endpoints and cloud link-local addresses
    blocked_hosts = [
        "169.254.169.254", "169.254.170.2", "instance-data",
        "metadata.google.internal", "metadata.goog"
    ]
    if hostname in blocked_hosts or hostname.startswith("169.254."):
        return JSONResponse(status_code=403, content={
            "ok": False,
            "status": 403,
            "error_type": "SSRF_BLOCKED",
            "message": "Access to internal cloud metadata IP addresses is restricted for security.",
            "proxied": True
        })

    method = req.method.upper()
    if method not in ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]:
        return JSONResponse(status_code=400, content={
            "ok": False,
            "status": 400,
            "error_type": "INVALID_METHOD",
            "message": f"HTTP method '{method}' is not supported.",
            "proxied": True
        })

    req_headers = {
        "User-Agent": "Vak-Terminal-API-Tester/1.0",
        "Accept": "*/*"
    }
    for k, v in req.headers.items():
        if k.lower() not in ["host", "content-length"]:
            req_headers[k] = v

    content_data = None
    if method in ["POST", "PUT", "PATCH"] and req.body:
        content_data = req.body.encode("utf-8")
        if "content-type" not in [k.lower() for k in req_headers]:
            req_headers["Content-Type"] = "application/json"

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(
            timeout=15.0,
            follow_redirects=True,
            verify=False
        ) as client:
            resp = await client.request(
                method=method,
                url=url,
                headers=req_headers,
                content=content_data
            )
            duration_ms = int((time.perf_counter() - t0) * 1000)

            # Limit body capture to 256KB to avoid browser freeze
            text_preview = resp.text[:256000]
            is_json = False
            try:
                parsed_json = json.loads(text_preview)
                formatted_body = json.dumps(parsed_json, indent=2)
                is_json = True
            except Exception:
                formatted_body = text_preview

            resp_headers = {
                k: v for k, v in resp.headers.items()
                if k.lower() in ["content-type", "server", "date", "content-length", "etag", "cache-control"]
            }

            return {
                "ok": resp.is_success,
                "status": resp.status_code,
                "status_text": resp.reason_phrase or ("OK" if resp.is_success else "HTTP Error"),
                "duration_ms": duration_ms,
                "headers": resp_headers,
                "body": formatted_body,
                "is_json": is_json,
                "content_type": resp.headers.get("content-type", ""),
                "proxied": True,
                "target_url": str(resp.url)
            }

    except httpx.ConnectTimeout:
        duration_ms = int((time.perf_counter() - t0) * 1000)
        return {
            "ok": False,
            "status": 504,
            "status_text": "GATEWAY TIMEOUT",
            "duration_ms": duration_ms,
            "error_type": "CONNECT_TIMEOUT",
            "message": f"Connection to {hostname} timed out after 15 seconds. The remote server is unresponsive.",
            "proxied": True,
            "target_url": url
        }
    except httpx.ReadTimeout:
        duration_ms = int((time.perf_counter() - t0) * 1000)
        return {
            "ok": False,
            "status": 504,
            "status_text": "READ TIMEOUT",
            "duration_ms": duration_ms,
            "error_type": "READ_TIMEOUT",
            "message": f"Connected to {hostname}, but reading the response timed out after 15 seconds.",
            "proxied": True,
            "target_url": url
        }
    except httpx.ConnectError:
        duration_ms = int((time.perf_counter() - t0) * 1000)
        return {
            "ok": False,
            "status": 502,
            "status_text": "BAD GATEWAY",
            "duration_ms": duration_ms,
            "error_type": "CONNECT_ERROR",
            "message": f"Could not establish connection to {hostname}. Verify the domain exists, DNS is resolving, and port is open.",
            "proxied": True,
            "target_url": url
        }
    except httpx.InvalidURL as e:
        return {
            "ok": False,
            "status": 400,
            "status_text": "INVALID URL",
            "duration_ms": 0,
            "error_type": "INVALID_URL",
            "message": f"Malformed URL: {str(e)}",
            "proxied": True,
            "target_url": url
        }
    except Exception as e:
        duration_ms = int((time.perf_counter() - t0) * 1000)
        logger.warning(f"Proxy test error for {url}: {e}")
        return {
            "ok": False,
            "status": 500,
            "status_text": "PROXY FAILURE",
            "duration_ms": duration_ms,
            "error_type": "UNEXPECTED_ERROR",
            "message": f"Unexpected proxy execution error: {str(e)}",
            "proxied": True,
            "target_url": url
        }


@app.get("/sessions/{session_id}")
async def get_session_details(session_id: str, uid: str | None = None):
    """Load details of a specific shift."""
    if not pipeline:
        return JSONResponse(status_code=503, content={"detail": "Service not ready"})
    try:
        session = await pipeline.get_or_load_session(session_id, user_id=uid)
        return {
            "session_id": session_id,
            "history": session.history,
            "insights": session.insights
        }
    except Exception as e:
        logger.error(f"Failed to load session {session_id}: {e}")
        return JSONResponse(status_code=404, content={"detail": f"Session {session_id} not found"})


@app.get("/sessions/{session_id}/report")
async def get_session_report(session_id: str, uid: str | None = None):
    """Fetch cached cognitive focus report or generate one dynamically."""
    if not pipeline:
        return JSONResponse(status_code=503, content={"detail": "Service not ready"})
    try:
        # 1. Try to load cached report from S3
        cached_report = await pipeline._storage.load_report(session_id, user_id=uid)
        if cached_report:
            logger.info(f"Loaded cached report for session {session_id} from S3.")
            return cached_report

        # 2. Not cached - generate report from history
        session = await pipeline.get_or_load_session(session_id, user_id=uid)
        if not session.history:
            return JSONResponse(
                status_code=400,
                content={"detail": "Cannot generate report for empty session history"}
            )
        
        logger.info(f"Generating new focus report for session {session_id}...")
        report = await pipeline._llm.generate_session_report(session.history)
        
        # 3. Cache it in S3
        await pipeline._storage.save_report(session_id, report, user_id=uid)
        
        return report
    except Exception as e:
        logger.error(f"Failed to get report for session {session_id}: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"detail": f"Failed to generate report: {str(e)}"}
        )


# ── WebSocket Voice Endpoint ──
@app.websocket("/ws/voice")
async def voice_websocket(ws: WebSocket, session_id: str | None = None, uid: str | None = None):
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
    logger.info(f"WebSocket connected: session {session_id[:8]} (user: {uid or 'anonymous'})")

    try:
        # Pre-load session and send initial data to client
        session = await pipeline.get_or_load_session(session_id, user_id=uid)
        await ws.send_json({
            "type": "session_init",
            "history": session.history,
            "insights": session.insights,
            "action_plan": session.action_plan,
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
                async for chunk in pipeline.process(audio_bytes, session_id, on_meta=on_meta, user_id=uid):
                    await ws.send_json({
                        "type": "audio",
                        "data": base64.b64encode(chunk).decode(),
                    })
                await ws.send_json({"type": "done"})

            elif msg["type"] == "text":
                # Text from client (STT done client-side or typed)
                user_text = msg["text"]
                async for chunk in pipeline.process_text(user_text, session_id, on_meta=on_meta, user_id=uid):
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
