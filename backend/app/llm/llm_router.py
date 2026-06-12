"""
vāk — LLM Client Router

Dynamically routes LLM completions, structured insights, and cognitive focus reports
across Cerebras, OpenRouter, and Groq with transparent fallback handling.
"""

import json
import logging
import time
from collections.abc import AsyncGenerator

from app.config import settings
from app.llm.groq_client import GroqClient

logger = logging.getLogger("vak.llm_router")


class LLMRouter:
    """
    Unified router that handles LLM completions, structured updates, and focus analytics.
    Attempts Cerebras/OpenRouter based on configuration and falls back to Groq.
    """

    def __init__(self):
        self._groq = None
        if settings.groq_api_key:
            try:
                self._groq = GroqClient()
            except Exception as e:
                logger.warning(f"Failed to initialize Groq client: {e}")

    async def _stream_httpx(self, url: str, headers: dict, body: dict) -> AsyncGenerator[str, None]:
        """Utility to stream OpenAI-compatible API endpoints using httpx."""
        import httpx
        async with httpx.AsyncClient(timeout=10.0) as client:
            async with client.stream("POST", url, headers=headers, json=body) as response:
                if response.status_code != 200:
                    error_text = await response.aread()
                    raise RuntimeError(f"HTTP {response.status_code}: {error_text.decode('utf-8')}")

                byte_buffer = bytearray()
                async for chunk in response.aiter_bytes():
                    byte_buffer.extend(chunk)
                    while b"\n" in byte_buffer:
                        line_bytes, byte_buffer = byte_buffer.split(b"\n", 1)
                        line = line_bytes.decode("utf-8", errors="ignore").strip()
                        if line.startswith("data:"):
                            data_content = line[5:].strip()
                            if data_content == "[DONE]":
                                break
                            try:
                                json_data = json.loads(data_content)
                                delta = json_data["choices"][0]["delta"]
                                if "content" in delta and delta["content"]:
                                    yield delta["content"]
                            except Exception:
                                pass

    async def stream_response(self, messages: list[dict]) -> AsyncGenerator[str, None]:
        """
        Stream response tokens. Routes through:
        1. Cerebras (Llama 3.1 8B for lowest voice latency)
        2. OpenRouter (Gemini 2.5 Flash / fallback)
        3. Groq (Llama 3.3 70B versatile fallback)
        """
        # 1. Cerebras
        if settings.cerebras_api_key:
            try:
                logger.info("Routing completion request to Cerebras...")
                url = "https://api.cerebras.ai/v1/chat/completions"
                headers = {
                    "Authorization": f"Bearer {settings.cerebras_api_key}",
                    "Content-Type": "application/json"
                }
                body = {
                    "model": settings.cerebras_model,
                    "messages": messages,
                    "stream": True,
                    "temperature": 0.7,
                    "max_tokens": 256
                }
                t_start = time.perf_counter()
                first = True
                async for token in self._stream_httpx(url, headers, body):
                    if first:
                        logger.info(f"Cerebras first token: {(time.perf_counter() - t_start)*1000:.0f}ms")
                        first = False
                    yield token
                return
            except Exception as e:
                logger.warning(f"Cerebras call failed: {e}. Falling back...")

        # 2. OpenRouter
        if settings.openrouter_api_key:
            try:
                logger.info("Routing completion request to OpenRouter...")
                url = "https://openrouter.ai/api/v1/chat/completions"
                headers = {
                    "Authorization": f"Bearer {settings.openrouter_api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://triplespeed.com",
                    "X-Title": "vak"
                }
                body = {
                    "model": settings.openrouter_model,
                    "messages": messages,
                    "stream": True,
                    "temperature": 0.7,
                    "max_tokens": 256
                }
                t_start = time.perf_counter()
                first = True
                async for token in self._stream_httpx(url, headers, body):
                    if first:
                        logger.info(f"OpenRouter first token: {(time.perf_counter() - t_start)*1000:.0f}ms")
                        first = False
                    yield token
                return
            except Exception as e:
                logger.warning(f"OpenRouter call failed: {e}. Falling back...")

        # 3. Groq
        if self._groq:
            logger.info("Routing completion request to Groq...")
            async for token in self._groq.stream_response(messages):
                yield token
        else:
            raise RuntimeError("No LLM client available to handle completions.")

    async def stream_sentences(self, messages: list[dict]) -> AsyncGenerator[str, None]:
        """Stream complete sentences for voice loop pipelines."""
        buffer = ""
        sentence_endings = {".", "?", "!", ";"}

        async for token in self.stream_response(messages):
            buffer += token
            while buffer:
                best_pos = -1
                for ending in sentence_endings:
                    pos = buffer.find(ending)
                    if pos != -1:
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

        if buffer.strip():
            yield buffer.strip()

    async def generate_insights(self, history: list[dict], current_insights: dict) -> dict:
        """Update user profile insights in the background. Uses OpenRouter -> Cerebras -> Groq."""
        formatted_history = "\n".join(
            [f"{m['role'].upper()}: {m['content']}" for m in history if m['role'] in ("user", "assistant")]
        )
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
        messages = [{"role": "user", "content": synthesis_prompt}]

        # 1. OpenRouter
        if settings.openrouter_api_key:
            try:
                logger.info("Routing insights generation to OpenRouter...")
                import httpx
                headers = {
                    "Authorization": f"Bearer {settings.openrouter_api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://triplespeed.com",
                    "X-Title": "vak"
                }
                body = {
                    "model": settings.openrouter_model,
                    "messages": messages,
                    "temperature": 0.2,
                    "max_tokens": 512
                }
                async with httpx.AsyncClient(timeout=15.0) as client:
                    response = await client.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=body)
                    if response.status_code == 200:
                        content = response.json()["choices"][0]["message"]["content"].strip()
                        return self._clean_json(content)
            except Exception as e:
                logger.warning(f"OpenRouter insights call failed: {e}. Falling back...")

        # 2. Cerebras
        if settings.cerebras_api_key:
            try:
                logger.info("Routing insights generation to Cerebras...")
                import httpx
                headers = {
                    "Authorization": f"Bearer {settings.cerebras_api_key}",
                    "Content-Type": "application/json"
                }
                body = {
                    "model": settings.cerebras_model,
                    "messages": messages,
                    "temperature": 0.2,
                    "max_tokens": 512
                }
                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.post("https://api.cerebras.ai/v1/chat/completions", headers=headers, json=body)
                    if response.status_code == 200:
                        content = response.json()["choices"][0]["message"]["content"].strip()
                        return self._clean_json(content)
            except Exception as e:
                logger.warning(f"Cerebras insights call failed: {e}. Falling back...")

        # 3. Groq
        if self._groq:
            logger.info("Routing insights generation to Groq...")
            return await self._groq.generate_insights(history, current_insights)

        return current_insights

    async def generate_session_title(self, history: list[dict]) -> str:
        """
        Generates a cool, punchy, 2-3 word title for the session based on the conversation topic.
        Uses OpenRouter -> Cerebras -> Groq for fallback.
        """
        user_msgs = [m['content'] for m in history if m['role'] == 'user']
        if not user_msgs:
            return "Seeking Clarity"
            
        context = "\n".join(user_msgs[:3])
        prompt = f"""You are the backend focus analyst for vāk.
Review the following user thoughts and generate a cool, punchy, non-corporate, and non-clinical title (maximum 3 words) summarizing the core struggle or theme.
Do NOT use clinical jargon or generic names. Use the tone of a perceptive friend.

Examples:
- User talking about code architecture vs CSS -> "Logic vs Styling"
- User talking about starting a new project -> "Project Launch Clarity"
- User anxious about a deadline -> "Deadline Friction"
- User struggling with work focus -> "Focus Stagnation"

User thoughts:
{context}

Respond ONLY with the 2-3 word title. No quotes, no prefix, no markdown.
"""
        messages = [{"role": "user", "content": prompt}]

        # 1. OpenRouter
        if settings.openrouter_api_key:
            try:
                logger.info("Routing title generation to OpenRouter...")
                import httpx
                headers = {
                    "Authorization": f"Bearer {settings.openrouter_api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://triplespeed.com",
                    "X-Title": "vak"
                }
                body = {
                    "model": settings.openrouter_model,
                    "messages": messages,
                    "temperature": 0.2,
                    "max_tokens": 16
                }
                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=body)
                    if response.status_code == 200:
                        content = response.json()["choices"][0]["message"]["content"].strip()
                        return content.replace('"', '').replace("'", "")
            except Exception as e:
                logger.warning(f"OpenRouter title call failed: {e}. Falling back...")

        # 2. Cerebras
        if settings.cerebras_api_key:
            try:
                logger.info("Routing title generation to Cerebras...")
                import httpx
                headers = {
                    "Authorization": f"Bearer {settings.cerebras_api_key}",
                    "Content-Type": "application/json"
                }
                body = {
                    "model": settings.cerebras_model,
                    "messages": messages,
                    "temperature": 0.2,
                    "max_tokens": 16
                }
                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.post("https://api.cerebras.ai/v1/chat/completions", headers=headers, json=body)
                    if response.status_code == 200:
                        content = response.json()["choices"][0]["message"]["content"].strip()
                        return content.replace('"', '').replace("'", "")
            except Exception as e:
                logger.warning(f"Cerebras title call failed: {e}. Falling back...")

        # 3. Groq
        if self._groq:
            try:
                logger.info("Routing title generation to Groq...")
                response = await self._groq._client.chat.completions.create(
                    model=self._groq._model,
                    messages=messages,
                    temperature=0.2,
                    max_tokens=16
                )
                content = response.choices[0].message.content.strip()
                return content.replace('"', '').replace("'", "")
            except Exception as e:
                logger.error(f"Groq title call failed: {e}")

        # Static fallback of coolnames
        from datetime import datetime
        hour = datetime.now().hour
        if 5 <= hour < 12:
            return "Morning Alignment"
        elif 12 <= hour < 17:
            return "Midday Focus"
        elif 17 <= hour < 22:
            return "Evening Review"
        else:
            return "Night Drift"

    async def generate_session_report(self, history: list[dict]) -> dict:
        """
        Synthesizes a dynamic cognitive focus and clarity report on relative baseline metrics.
        Instructs OpenRouter (primary) / Cerebras / Groq to analyze the session dynamically.
        """
        formatted_history = "\n".join(
            [f"{m['role'].upper()}: {m['content']}" for m in history if m['role'] in ("user", "assistant")]
        )
        report_prompt = f"""You are the backend focus analyst for vāk.
Analyze this conversation transcript for signals of resistance, focus posture, avoidance, and clarity.
We want to construct a dynamic, highly personal, and non-judgmental report of the user's focus patterns, comparing the user to their own baseline rather than a population.

Every metric must be relative and descriptive. Do NOT use numbers out of 100, clinical jargon, or gamified scores. Use the perceptive, friendly, and honest language of an observant close friend.

Analyze the text to compute the following research-backed metrics:
1. `attentional_entropy`: Relative description of cognitive load, semantic fragmentation, or concept switching (e.g. "Spacious (clear, unhurried)", "Balanced (focused)", "Crowded (fragmented, jumping topics)", "Narrowed (hyper-focused)").
2. `emotional_granularity`: User's ability to label feelings/blockers specifically rather than using binary "good/bad" labels (e.g. "High Precision (distinguishes fatigue from anxiety)", "Moderate (general categorization)", "Low (global labeling)").
3. `narrative_coherence`: User's agency and ownership in self-storytelling vs. passive victimhood/circumstantial drift (e.g. "Agentic Alignment (owns decisions and next steps)", "Neutral Observational", "Circumstantial Drift (externalizes blockers/passive)").
4. `attentional_avoidance`: Recursive deflections or loops away from high-friction subjects (e.g. "Zero Resistance (direct confrontation)", "Deflective Loop (circles blocker)", "Active Avoidance (pivots to safe topics)").
5. `cognitive_momentum`: Momentum and velocity of translating ideas/planning into concrete execution targets (e.g. "Direct Flow (ready to act)", "Hovering (planning loop)", "Anxious Paralysis (stuck in loop)").
6. `focus_rhythm`:
   - `peak_clarity_window`: Peak clarity windows — when in the day do their conversations sound sharpest? (e.g. "Early Mornings (8 AM - 10 AM)", "Late Night (11 PM - 1 AM)")
   - `consistency_score`: Focus consistency score over 7 / 30 days based on their tone and clarity (e.g. "6.5 / 10", "8.2 / 10")
   - `distraction_fingerprint`: Distraction fingerprint — what topics or times correlate with their most scattered sessions? (e.g. "Late night doomscrolling anxiety" or "Administrative dread when starting hard tasks")
7. `emotional_weather`:
   - `mood_baseline`: Mood baseline — their personal normal, not a clinical scale (e.g. "Alert but slightly guarded" or "Calm and conversational")
   - `drift_detection`: Drift detection — are they trending heavier over the past week? (e.g. "Trending slightly heavier over the past week" or "Steady mood baseline")
   - `resilience_pattern`: Resilience pattern — how quickly do they recover from low sessions? (e.g. "Recovering quickly after expressing blocking concerns" or "Slow to pivot away from anxiety loops")
   - `vocabulary_growth`: Emotional vocabulary growth — are they getting better at naming what they feel? (e.g. "Getting better at distinguishing avoidance from physical fatigue" or "Using rich words to name specific blockers")
8. `momentum_patterns`:
   - `talk_to_action_ratio`: Talk-to-action ratio — how often do their conversations convert to movement? (e.g. "3 out of 5 statements lead to immediate movement" or "High planning, low immediate action")
   - `avoidance_loops`: Avoidance loops — topics that keep coming back unresolved (e.g. "Circled back to the project launch timeline 4 times without an action item")
   - `breakthrough_moments`: Breakthrough moments — sessions where something clearly shifted, logged and surfaced (e.g. "Shifting focus from styling to raw feature planning at the 12-minute mark")
9. `identity_signals`:
   - `talk_vs_action_gap`: What they talk about most vs what they say matters most — the gap between them is revealing (e.g. "You talk most about long-term vision, but prioritize low-risk UI tweaks" or "DESIRED: Autonomy, ACTUAL: Minor styling edits")
   - `values_in_conflict`: Values in conflict — recurring tensions Vāk has detected across conversations (e.g. "Desiring absolute autonomy vs. seeking validation from external partners")
   - `narrative_drift`: Self-narrative drift — is the story they tell about themselves getting stronger or smaller over time? (e.g. "Story is getting stronger as you commit to small shipping targets")
10. `actionable_insights`: A list of 2-3 highly personal, sharp, conversational reflections. Ensure they are longitudinal, specific, and non-generic. Use these examples as few-shot guides:
    - "You've had three conversations this week that started with work anxiety and ended unresolved. You tend to go quiet on it right when you get close. Tomorrow, start there."
    - "Your clearest thinking happens in your morning sessions. You've been having hard conversations at night — that might be why they're not landing."
    - "You've mentioned starting that project in four separate conversations. You already know what the first step is. You said it yourself on Tuesday."

Latest conversation history:
{formatted_history}

Return ONLY a valid JSON object matching this schema:
{{
  "attentional_entropy": "Crowded (fragmented, jumping topics)",
  "emotional_granularity": "High Precision (distinguishes fatigue from anxiety)",
  "narrative_coherence": "Agentic Alignment (owns decisions and next steps)",
  "attentional_avoidance": "Deflective Loop (circles blocker)",
  "cognitive_momentum": "Hovering (planning loop)",
  "focus_rhythm": {{
    "peak_clarity_window": "Early Mornings (8 AM - 10 AM)",
    "consistency_score": "6.2 / 10",
    "distraction_fingerprint": "Late night anxiety or administrative dread"
  }},
  "emotional_weather": {{
    "mood_baseline": "Alert but slightly guarded",
    "drift_detection": "Trending slightly heavier over the past week",
    "resilience_pattern": "Recovering quickly after expressing blocking concerns",
    "vocabulary_growth": "Getting better at distinguishing avoidance from fatigue"
  }},
  "momentum_patterns": {{
    "talk_to_action_ratio": "3 out of 5 statements lead to movement",
    "avoidance_loops": "Circled back to work timeline 4 times unresolved",
    "breakthrough_moments": "Pivoted from styling to logic at the 12-minute mark"
  }},
  "identity_signals": {{
    "talk_vs_action_gap": "Talks long-term vision, but prioritizes low-risk tweaks",
    "values_in_conflict": "Autonomy desires vs. external validation search",
    "narrative_drift": "Narrative getting stronger with small shipping targets"
  }},
  "actionable_insights": [
    "You've had three conversations this week that started with work anxiety and ended unresolved. You tend to go quiet on it right when you get close. Tomorrow, start there.",
    "Your clearest thinking happens in your morning sessions. You've been having hard conversations at night — that might be why they're not landing."
  ]
}}

Respond with the JSON block and nothing else. Do not wrap in markdown code blocks.
"""
        messages = [{"role": "user", "content": report_prompt}]
        default_report = {
            "attentional_entropy": "Spacious (clear, unhurried)",
            "emotional_granularity": "High Precision (differentiates feelings clearly)",
            "narrative_coherence": "Agentic Alignment (high user agency)",
            "attentional_avoidance": "Zero Resistance (direct problem solving)",
            "cognitive_momentum": "Direct Flow (ready to act)",
            "focus_rhythm": {
                "peak_clarity_window": "Consistent across sessions",
                "consistency_score": "8.5 / 10",
                "distraction_fingerprint": "Minor administrative overhead"
            },
            "emotional_weather": {
                "mood_baseline": "Alert and centered",
                "drift_detection": "Steady baseline calm",
                "resilience_pattern": "Immediate recovery and action setup",
                "vocabulary_growth": "Highly descriptive of internal blockers"
            },
            "momentum_patterns": {
                "talk_to_action_ratio": "4 out of 5 statements focus on execution",
                "avoidance_loops": "None detected",
                "breakthrough_moments": "Consistently pivoting to shipping"
            },
            "identity_signals": {
                "talk_vs_action_gap": "Well-aligned between focus and actions",
                "values_in_conflict": "None active",
                "narrative_drift": "Narrative growing stronger and clearer"
            },
            "actionable_insights": [
                "You are maintaining excellent alignment. Focus on executing the next minor checklist item immediately to maintain this cadence."
            ]
        }

        # 1. OpenRouter
        if settings.openrouter_api_key:
            try:
                logger.info("Routing report generation to OpenRouter...")
                import httpx
                headers = {
                    "Authorization": f"Bearer {settings.openrouter_api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://triplespeed.com",
                    "X-Title": "vak"
                }
                body = {
                    "model": settings.openrouter_model,
                    "messages": messages,
                    "temperature": 0.2,
                    "max_tokens": 1024
                }
                async with httpx.AsyncClient(timeout=20.0) as client:
                    response = await client.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=body)
                    if response.status_code == 200:
                        content = response.json()["choices"][0]["message"]["content"].strip()
                        return self._clean_json(content)
            except Exception as e:
                logger.warning(f"OpenRouter report generation failed: {e}. Falling back...")

        # 2. Cerebras
        if settings.cerebras_api_key:
            try:
                logger.info("Routing report generation to Cerebras...")
                import httpx
                headers = {
                    "Authorization": f"Bearer {settings.cerebras_api_key}",
                    "Content-Type": "application/json"
                }
                body = {
                    "model": settings.cerebras_model,
                    "messages": messages,
                    "temperature": 0.2,
                    "max_tokens": 1024
                }
                async with httpx.AsyncClient(timeout=15.0) as client:
                    response = await client.post("https://api.cerebras.ai/v1/chat/completions", headers=headers, json=body)
                    if response.status_code == 200:
                        content = response.json()["choices"][0]["message"]["content"].strip()
                        return self._clean_json(content)
            except Exception as e:
                logger.warning(f"Cerebras report generation failed: {e}. Falling back...")

        # 3. Groq
        if self._groq:
            try:
                logger.info("Routing report generation to Groq...")
                response = await self._groq._client.chat.completions.create(
                    model=self._groq._model,
                    messages=messages,
                    temperature=0.2,
                    max_tokens=1024
                )
                content = response.choices[0].message.content.strip()
                return self._clean_json(content)
            except Exception as e:
                logger.error(f"Groq report generation failed: {e}")

        return default_report

    def _clean_json(self, content: str) -> dict:
        """Strip markdown ticks and load JSON."""
        cleaned = content.strip()
        if cleaned.startswith("```"):
            lines = cleaned.splitlines()
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines[-1].startswith("```"):
                lines = lines[:-1]
            cleaned = "\n".join(lines).strip()
        return json.loads(cleaned)
