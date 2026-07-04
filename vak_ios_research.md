# vāk iOS — On-Device Voice Agent Research

## The Core Question

Can vāk run as a **fully on-device voice agent** on iOS, with Apple Private Cloud Compute (PCC) as a fallback for heavy reasoning — while maintaining sub-500ms conversational latency?

---

## 1. Apple Foundation Models — Model Sizes (AFM 3, iOS 26)

Apple ships **5 models** across two tiers:

### On-Device
| Model | Params | Activation | Purpose |
|-------|--------|------------|---------|
| **AFM 3 Core** | ~3B dense | 3B | Routing, fast NLU, lightweight text tasks |
| **AFM 3 Core Advanced** | ~20B sparse | 1–4B per prompt | Siri, dictation, image understanding, agentic features |

### Private Cloud Compute (PCC)
| Model | Params | Purpose |
|-------|--------|---------|
| **AFM 3 Cloud** | Undisclosed (est. 30–70B) | Server-side workhorse, speed-optimized |
| **ADM 3 Cloud** | Undisclosed | Image generation/editing |
| **AFM 3 Cloud Pro** | Undisclosed (est. 100B+) | Complex reasoning, agentic tool use |

> [!IMPORTANT]
> **The 3B on-device model is accessible to developers via the Foundation Models framework in iOS 26.** You can call it directly from Swift with zero API cost, zero latency, and full offline capability. The 20B sparse model is system-only (Siri/Apple Intelligence) — not exposed to third-party apps.

### What This Means for vāk

The on-device 3B model is **sufficient for**:
- Intent classification, routing
- Short conversational responses
- Structured output generation (`@Generable` macro)
- Tool calling (querying local data, triggering app actions)

It is **NOT sufficient for**:
- Deep cognitive analysis (the session reports vāk currently generates)
- Complex multi-turn reasoning about emotional patterns
- Long-context processing (session histories > few thousand tokens)

**PCC fills the gap** — heavier analysis (session reports, insight extraction) gets routed to Cloud/Cloud Pro models automatically, with full privacy guarantees. Data is never stored by Apple or shared.

---

## 2. Rumik AI — Silk Mulberry Analysis

### What It Is
**Silk Mulberry 1.5** is an audio language model (not traditional TTS) by Rumik AI (Bengaluru-based, seed-stage, backed by Info Edge Ventures).

| Aspect | Detail |
|--------|--------|
| **Architecture** | Transformer backbone → speech tokens → audio decoder |
| **Model Size** | Not publicly disclosed (closed weights) |
| **Latency** | Sub-200ms time-to-first-chunk (on H100 GPUs) |
| **Access** | **API-only** — no downloadable weights |
| **Pricing** | $0.01 / 1,000 tokens (Mulberry), $0.025 / 1K (Muga) |
| **Open Source** | Promised but **not delivered** — still closed-source |
| **Strengths** | Hinglish/code-switching, emotional expressiveness, voice design from text descriptions |

### Key Features
- **Voice Design**: Generate synthetic voices from plain-language descriptions (age, accent, pitch, emotional register) — no preset voices needed
- **Expressiveness**: Handles pauses, emotional shifts, laughing, whispering, crying
- **Multilingual Blending**: Hindi/English code-switching (Hinglish, Tanglish, Manglish)

### Viability Assessment for vāk

> [!WARNING]
> **Silk Mulberry cannot run on-device.** It's API-only with closed weights. This directly contradicts the on-device/PCC architecture we're exploring.

**Where it fits:**
- As a **cloud TTS fallback** for premium voice quality (especially for Hindi/English code-switching)
- As a **benchmark** for the expressiveness bar vāk should aim for

**Where it doesn't fit:**
- On-device iOS pipeline (no weights available)
- Privacy-first architecture (requires network calls to Rumik's servers)
- Cost at scale ($0.01/1K tokens adds up for a voice-first app)

---

## 3. On-Device Voice Pipeline for iOS — The Real Stack

For a fully on-device voice agent on iPhone, here's what actually works today:

### The Pipeline

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│   VAD    │ →  │   STT    │ →  │   LLM    │ →  │   TTS    │
│ (detect  │    │ (speech  │    │ (reason  │    │ (speak   │
│  speech) │    │  to text)│    │  + reply)│    │  back)   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
   ~10ms          ~150ms          ~200ms          ~80ms
              ═══════════════════════════════════════════
                        Target: < 500ms total
```

### Component Options

#### STT (Speech → Text)
| Option | Size | Latency (iPhone 15+) | Notes |
|--------|------|---------------------|-------|
| **WhisperKit** (Whisper tiny/base) | 39–74MB | ~100–200ms | Best open-source option, Core ML optimized |
| **Apple SpeechAnalyzer** (iOS 26) | System | ~100ms | New first-party, long-duration optimized |
| **Deepgram** (current vāk) | Cloud | ~300ms + network | What you're using now — good but requires internet |

#### LLM (Reasoning)
| Option | Size | Latency | Notes |
|--------|------|---------|-------|
| **Apple Foundation Models** (3B) | System (~2GB) | ~200ms | Free, on-device, Swift-native, `@Generable` macro |
| **Qwen3 0.6B/1.7B** (Core ML) | 0.5–1.5GB | ~100–300ms | Smaller, faster, but less capable |
| **Llama 3.2 1B** (Core ML) | ~1GB | ~150ms | Good balance for simple conversations |
| **PCC Cloud** (AFM 3 Cloud Pro) | Server | ~400ms + network | For heavy reasoning (reports, deep analysis) |

#### TTS (Text → Speech)
| Option | Size | Latency | Notes |
|--------|------|---------|-------|
| **Kokoro-82M** (current vāk) | ~82MB | <100ms | Already in your stack, Core ML + MLX Swift ready |
| **Apple AVSpeechSynthesizer** | System | ~50ms | Built-in but robotic |
| **Silk Mulberry** (Rumik) | Cloud API | ~200ms + network | Best expressiveness, but cloud-only |

### Recommended Architecture: **Hybrid On-Device + PCC**

```
┌─────────────────────────────────────────────────┐
│                  iPhone (On-Device)              │
│                                                   │
│  ┌─────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │WhisperKit│→ │Apple FM (3B) │→ │  Kokoro-82M │ │
│  │  (STT)   │  │   (LLM)      │  │   (TTS)     │ │
│  └─────────┘  └──────┬───────┘  └─────────────┘ │
│                       │                           │
│              ┌────────▼────────┐                  │
│              │ Complexity Gate  │                  │
│              │ (route to PCC   │                  │
│              │  if needed)     │                  │
│              └────────┬────────┘                  │
└───────────────────────┼───────────────────────────┘
                        │ (only when needed)
                        ▼
┌─────────────────────────────────────────────────┐
│           Apple Private Cloud Compute            │
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │  AFM 3 Cloud Pro                          │    │
│  │  - Session report generation              │    │
│  │  - Deep cognitive pattern analysis        │    │
│  │  - Insight extraction across sessions     │    │
│  │  - Complex multi-turn reasoning           │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

---

## 4. Latency Budget — Can It Feel Instant?

| Stage | On-Device | With Cloud Fallback |
|-------|-----------|-------------------|
| VAD | ~10ms | ~10ms |
| STT (WhisperKit base) | ~150ms | ~150ms |
| LLM (Apple FM 3B) | ~200ms | — |
| LLM (PCC Cloud Pro) | — | ~400ms + 50ms network |
| TTS (Kokoro) | ~80ms | ~80ms |
| **Total** | **~440ms** ✅ | **~690ms** ⚠️ |

> [!TIP]
> The on-device path hits **sub-500ms** — this feels like real-time conversation. PCC fallback adds ~250ms but is only triggered for complex reasoning tasks, not every turn.

---

## 5. What About Model Size on iPhone?

Total on-device footprint for the full vāk pipeline:

| Component | Size |
|-----------|------|
| WhisperKit (base) | ~74MB |
| Apple FM 3B | System (free — already on device) |
| Kokoro-82M | ~82MB |
| vāk app + assets | ~50MB |
| **Total** | **~206MB** |

> [!NOTE]
> This is extremely lean. For context, Instagram is ~400MB. The Apple FM 3B model doesn't count against your app size because it's part of the OS.

---

## 6. Open Questions

### Product Direction
1. **What does vāk become beyond "focus"?** If it's a voice-first thinking partner, the scope expands to: journaling, decision-making, emotional processing, goal tracking — not just focus sessions. The cognitive report is the differentiator, not the chat.

2. **Silk Mulberry for Hindi/English?** If vāk targets Indian users who code-switch, Rumik's TTS quality is genuinely superior. But it requires cloud calls. Worth it as an **optional premium voice** with Kokoro as the default on-device voice?

3. **PCC availability in India?** Apple's PCC is expanding but may have regional limitations. Need to verify latency from Indian data centers.

### Technical
4. **Apple FM 3B context window?** The on-device model likely has a limited context window. How do we handle long session histories? Summarization + retrieval?

5. **Core ML conversion pipeline?** WhisperKit and Kokoro both have Core ML paths, but we need to validate performance on iPhone 15 (non-Pro) and older devices with smaller Neural Engines.

6. **Background processing?** Can vāk generate cognitive reports in the background using PCC while the user isn't actively in the app?

---

## 7. Verdict

| Approach | Viability | Recommendation |
|----------|-----------|----------------|
| **Fully on-device (WhisperKit + Apple FM + Kokoro)** | ✅ High | Best for MVP — sub-500ms, zero cost, full privacy |
| **Hybrid (on-device + PCC for reports)** | ✅ High | Best for production — keeps conversational turns fast, heavy analysis in PCC |
| **Silk Mulberry as primary TTS** | ⚠️ Medium | Cloud-only, closed weights — use as optional premium, not core |
| **Fully cloud (current vāk architecture)** | ❌ Not ideal for iOS | Defeats the purpose of going native — latency, cost, privacy concerns |

### Bottom Line
**Build the iOS app with the hybrid on-device + PCC architecture.** Use Apple Foundation Models for conversational turns (free, fast, private), WhisperKit for STT, Kokoro for TTS, and route complex cognitive analysis to PCC. Silk Mulberry is interesting for voice expressiveness but shouldn't be a dependency — it's API-only with closed weights from a seed-stage startup.
