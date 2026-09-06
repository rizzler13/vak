"""
vāk — Agentic Action Engine

Extracts concrete, actionable deliverables (tasks, bash commands, code blueprints, architecture notes)
from conversational exchanges in real time to power the interactive Action Deck.
"""

import json
import logging
from typing import Any
from app.config import settings

logger = logging.getLogger("vak.agent_tools")


class AgentActionExtractor:
    """
    Synthesizes structured Action Plans, task checklists, and CLI commands
    from ongoing voice/text dialogue.
    """

    def __init__(self, llm_router=None):
        self._router = llm_router

    async def extract_action_plan(
        self, user_text: str, assistant_text: str, history: list[dict]
    ) -> dict[str, Any] | None:
        """
        Analyze the exchange and synthesize a structured action plan.
        Returns None if the exchange is purely conversational with no actionable work.
        """
        recent_exchanges = "\n".join(
            [f"{m['role'].upper()}: {m['content']}" for m in history[-4:] if m['role'] in ('user', 'assistant')]
        )
        if not recent_exchanges:
            recent_exchanges = f"USER: {user_text}\nASSISTANT: {assistant_text}"

        prompt = f"""You are the agentic execution parser for vāk, a high-agency technical thinking and execution partner.
Based on the conversation below, extract or construct a concrete, structured ACTION PLAN that gets real work done.

CONVERSATION:
{recent_exchanges}

LATEST EXCHANGE:
USER: {user_text}
ASSISTANT: {assistant_text}

Analyze the user's intent, the technical requirements, and the assistant's recommendation.
Generate a structured JSON object with:
1. "title": A punchy, concrete action title (max 5 words, e.g. "CloudFront WebSocket Configuration", "FastAPI CORS Setup", "Docker Build Pipeline").
2. "objective": A 1-sentence technical objective.
3. "tasks": 2-4 concrete, actionable checklist steps with "id" (e.g. "t1"), "text", "priority" ("high", "medium", "normal"), and "status" ("pending").
4. "commands": 1-3 practical shell/bash commands that test, build, or verify the work (e.g. curl, git, docker, npm, python). If none apply, provide an empty list [].
5. "code_snippet": Optional dict with "filename", "language", and "code" containing relevant snippet or configuration. If not applicable, set to null.
6. "notes": 1-2 sentence architectural rationale or constraint to remember.

Return ONLY a valid JSON object matching this schema:
{{
  "title": "...",
  "objective": "...",
  "tasks": [
    {{"id": "t1", "text": "...", "priority": "high", "status": "pending"}}
  ],
  "commands": ["..."],
  "code_snippet": {{"filename": "...", "language": "...", "code": "..."}},
  "notes": "..."
}}

Return ONLY the raw JSON block without markdown formatting or backticks.
"""

        messages = [{"role": "user", "content": prompt}]

        # Try OpenRouter -> Cerebras -> Groq
        if settings.openrouter_api_key:
            try:
                import httpx
                headers = {
                    "Authorization": f"Bearer {settings.openrouter_api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://triplespeed.com",
                    "X-Title": "vak",
                }
                body = {
                    "model": settings.openrouter_model,
                    "messages": messages,
                    "temperature": 0.2,
                    "max_tokens": 700,
                }
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.post(
                        "https://openrouter.ai/api/v1/chat/completions",
                        headers=headers,
                        json=body,
                    )
                    if resp.status_code == 200:
                        content = resp.json()["choices"][0]["message"]["content"].strip()
                        return self._parse_json(content)
            except Exception as e:
                logger.warning(f"OpenRouter action extraction failed: {e}")

        if settings.cerebras_api_key:
            try:
                import httpx
                headers = {
                    "Authorization": f"Bearer {settings.cerebras_api_key}",
                    "Content-Type": "application/json",
                }
                body = {
                    "model": settings.cerebras_model,
                    "messages": messages,
                    "temperature": 0.2,
                    "max_tokens": 700,
                }
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.post(
                        "https://api.cerebras.ai/v1/chat/completions",
                        headers=headers,
                        json=body,
                    )
                    if resp.status_code == 200:
                        content = resp.json()["choices"][0]["message"]["content"].strip()
                        return self._parse_json(content)
            except Exception as e:
                logger.warning(f"Cerebras action extraction failed: {e}")

        if self._router and self._router._groq:
            try:
                resp = await self._router._groq._client.chat.completions.create(
                    model=self._router._groq._model,
                    messages=messages,
                    temperature=0.2,
                    max_tokens=700,
                )
                content = resp.choices[0].message.content.strip()
                return self._parse_json(content)
            except Exception as e:
                logger.warning(f"Groq action extraction failed: {e}")

        return {
            "title": "Action Checklist",
            "objective": f"Execute work addressing: {user_text[:60]}",
            "tasks": [
                {"id": "t1", "text": f"Define requirements for: {user_text[:50]}", "priority": "high", "status": "pending"},
                {"id": "t2", "text": "Implement and test solution", "priority": "medium", "status": "pending"},
                {"id": "t3", "text": "Verify output against benchmarks", "priority": "normal", "status": "pending"},
            ],
            "commands": [],
            "code_snippet": None,
            "notes": "Action plan generated for task execution.",
        }

    def _parse_json(self, text: str) -> dict[str, Any] | None:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            lines = cleaned.splitlines()
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            cleaned = "\n".join(lines).strip()
        try:
            data = json.loads(cleaned)
            if isinstance(data, dict) and "tasks" in data:
                return data
        except Exception as e:
            logger.error(f"Failed to parse action plan JSON: {e}")
        return None
