"""
vāk — Data Schemas
"""

from pydantic import BaseModel


class TextMessage(BaseModel):
    """Text input from the user (when STT is done client-side)."""
    text: str
    session_id: str = "default"


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    engines: dict[str, str]
    keys: dict[str, bool]
