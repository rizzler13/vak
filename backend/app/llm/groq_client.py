"""
vāk — Groq LLM Client

Streaming inference via Groq's API.
Groq runs Llama 3.1 70B at ~800 tokens/sec — fastest free LLM inference available.
"""

import time
import json
import logging
from collections.abc import AsyncGenerator

from groq import AsyncGroq

from app.config import settings

logger = logging.getLogger("vak.llm")


class GroqClient:
    """Async streaming client for Groq LLM API."""

    def __init__(self):
        if not settings.groq_api_key:
            raise ValueError("GROQ_API_KEY not set. Cannot initialize LLM client.")
        self._client = AsyncGroq(api_key=settings.groq_api_key)
        self._model = settings.groq_model

    async def stream_response(
        self, messages: list[dict]
    ) -> AsyncGenerator[str, None]:
        """
        Stream LLM response token-by-token.

        Yields individual tokens as they arrive from Groq.
        Logs time-to-first-token for latency tracking.
        """
        t_start = time.perf_counter()
        first_token = True

        stream = await self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            stream=True,
            temperature=0.7,
            max_tokens=256,  # Keep responses short — this is voice
        )

        async for chunk in stream:
            delta = chunk.choices[0].delta
            if delta.content:
                if first_token:
                    t_first = time.perf_counter() - t_start
                    logger.info(f"LLM first token: {t_first * 1000:.0f}ms")
                    first_token = False
                yield delta.content

    async def stream_sentences(
        self, messages: list[dict]
    ) -> AsyncGenerator[str, None]:
        """
        Stream complete sentences from the LLM.

        Buffers tokens until a sentence boundary (. ? ! ;) is detected,
        then yields the complete sentence. This is what feeds into TTS —
        we want to synthesize complete sentences, not fragments.
        """
        buffer = ""
        sentence_endings = {".", "?", "!", ";"}

        async for token in self.stream_response(messages):
            buffer += token

            # Check if we have a complete sentence
            # Look for sentence-ending punctuation followed by a space or end
            while buffer:
                # Find the earliest sentence boundary
                best_pos = -1
                for ending in sentence_endings:
                    pos = buffer.find(ending)
                    if pos != -1:
                        # Make sure it's actually a sentence end, not e.g. "Dr."
                        # Simple heuristic: if followed by space/end/quote, it's a boundary
                        after_pos = pos + 1
                        if after_pos >= len(buffer) or buffer[after_pos] in (" ", '"', "'", "\n"):
                            if best_pos == -1 or pos < best_pos:
                                best_pos = pos

                if best_pos != -1:
                    sentence = buffer[: best_pos + 1].strip()
                    buffer = buffer[best_pos + 1 :].lstrip()
                    if sentence:
                        yield sentence
                else:
                    break

        # Flush remaining buffer
        if buffer.strip():
            yield buffer.strip()

    async def generate_insights(self, history: list[dict], current_insights: dict) -> dict:
        """
        Generate/update user insights based on the conversation history.

        Args:
            history: List of messages in the session.
            current_insights: Dictionary of current insights loaded from S3.

        Returns:
            Dictionary of updated user insights.
        """
        if not history:
            return current_insights

        # Format history for the prompt
        formatted_history = "\n".join(
            [f"{m['role'].upper()}: {m['content']}" for m in history if m['role'] in ("user", "assistant")]
        )

        # Construct synthesis prompt
        synthesis_prompt = f"""You are the backend cognitive synthesizer for vāk, an emotionally intelligent thinking partner.
Your job is to read the latest conversation exchanges and the user's existing profile context, and generate an updated, distilled JSON profile.

Existing profile context:
{json.dumps(current_insights, indent=2)}

Latest conversation history:
{formatted_history}

Analyze the user's statements, emotions, struggles, avoidances, triggers, and the people they mention. Update the profile to reflect these.
Keep the profile extremely high quality, clear, and actionable. Do not add fluff.

Return ONLY a valid JSON object matching this schema:
{{
  "recurring_avoidances": ["list of specific tasks, emotions, or topics the user actively avoids or deflects"],
  "emotional_triggers": ["specific situations, thoughts, or feelings that cause anxiety, stagnation, or defense mechanisms"],
  "philosophy_alignment": "A single sentence explaining what type of energy they need right now (e.g. David Goggins radical accountability, Stoic presence, or Taoist stillness)",
  "key_people": {{
    "name": "brief description of relation and context"
  }}
}}

Respond with the JSON block and nothing else. Do not wrap in markdown code blocks.
"""
        try:
            logger.info("Generating updated user insights...")
            response = await self._client.chat.completions.create(
                model=self._model,
                messages=[{"role": "user", "content": synthesis_prompt}],
                temperature=0.2, # low temp for structured response
                max_tokens=512,
            )
            content = response.choices[0].message.content.strip()
            # Clean up markdown if any
            if content.startswith("```"):
                lines = content.splitlines()
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines[-1].startswith("```"):
                    lines = lines[:-1]
                content = "\n".join(lines).strip()

            updated = json.loads(content)
            logger.info("Successfully generated updated user insights.")
            return updated
        except Exception as e:
            logger.error(f"Failed to generate user insights: {e}", exc_info=True)
            return current_insights


