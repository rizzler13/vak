#!/usr/bin/env python3
"""
vāk — Entry Point

Run with: python run.py
"""

import uvicorn
from app.config import settings

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
        log_level="info",
    )
        ws_max_size=5 * 1024 * 1024,  # 5 MB max WebSocket message size
    )
