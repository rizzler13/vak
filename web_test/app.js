/**
 * vāk — Web Test Client
 *
 * Connects to the FastAPI backend via WebSocket.
 * Captures mic audio, sends it to the backend, plays back TTS audio.
 * Also supports text input for testing without a mic.
 */

// ── Config ──
// Use window.VAK_API_URL if explicitly injected. Otherwise, if running on localhost,
// connect directly to the EC2 backend. If running in production on CloudFront,
const API_URL = window.VAK_API_URL || (window.location.origin && window.location.origin.startsWith('http')
    ? window.location.origin
    : 'http://localhost:8000');
const WS_URL = API_URL.replace(/^http/, 'ws');

// ── State ──
let ws = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let audioContext = null;
let audioQueue = [];
let isPlaying = false;
let activeAudioSource = null;
let currentState = 'idle'; // idle, listening, thinking, speaking
let currentAssistantBubble = null;

function stopAssistantSpeaking() {
    audioQueue = [];
    if (activeAudioSource) {
        try {
            activeAudioSource.stop();
        } catch (e) {
            // Already stopped or not started
        }
        activeAudioSource = null;
    }
    isPlaying = false;
}

// Kanye West Music Player State
let kanyePlaying = false;
const kanyeAudio = document.getElementById('kanye-music');
const kanyePlayBtn = document.getElementById('kanye-play-btn');
const kanyeVisualizer = document.getElementById('kanye-visualizer');

// ── DOM Bindings ──
const orb1 = document.getElementById('orb-pulse-1');
const orb2 = document.getElementById('orb-pulse-2');
const liveMicBtn = document.getElementById('live-mic-btn');
const micIcon = document.getElementById('mic-icon');
const micLabel = document.getElementById('mic-label');
const voiceStateText = document.getElementById('voice-state-text');

const wsDot = document.getElementById('voice-ws-dot');
const wsStatus = document.getElementById('voice-ws-status');
const activeEnginesHud = document.getElementById('active-engines-hud');
const transcriptArea = document.getElementById('voice-transcript-area');
const insightsSnippet = document.getElementById('insights-snippet');
const insightsContent = document.getElementById('insights-content');

const textInput = document.getElementById('voice-text-input');
const textSend = document.getElementById('voice-text-send-btn');

// Metrics elements
const metricStt = document.getElementById('metric-stt');
const metricLlm = document.getElementById('metric-llm');
const metricTts = document.getElementById('metric-tts');

// Action Deck DOM Bindings
const tabDialogueBtn = document.getElementById('tab-dialogue-btn');
const tabActionBtn = document.getElementById('tab-action-btn');
const actionDeckArea = document.getElementById('action-deck-area');
const actionDeckEmpty = document.getElementById('action-deck-empty');
const actionDeckContent = document.getElementById('action-deck-content');
const actionTaskCount = document.getElementById('action-task-count');
const actionPlanBadge = document.getElementById('action-plan-badge');
const actionPlanTitle = document.getElementById('action-plan-title');
const actionPlanObjective = document.getElementById('action-plan-objective');
const actionTaskList = document.getElementById('action-task-list');
const actionTaskProgress = document.getElementById('action-task-progress');
const actionCommandsContainer = document.getElementById('action-commands-container');
const actionCommandsList = document.getElementById('action-commands-list');
const actionCodeContainer = document.getElementById('action-code-container');
const actionCodeBlock = document.getElementById('action-code-block');
const actionCodeFilename = document.getElementById('action-code-filename');
const actionNotesContainer = document.getElementById('action-notes-container');
const actionNotesText = document.getElementById('action-notes-text');
const exportPlanBtn = document.getElementById('export-plan-btn');
const exportBtnLabel = document.getElementById('export-btn-label');
const copyCodeBtn = document.getElementById('copy-code-btn');

// Browser Execution Tools DOM Bindings
const actionDiagramContainer = document.getElementById('action-diagram-container');
const actionDiagramRender = document.getElementById('action-diagram-render');
const copyMermaidBtn = document.getElementById('copy-mermaid-btn');
const actionApiContainer = document.getElementById('action-api-container');
const apiTestBadge = document.getElementById('api-test-badge');
const apiTestMethod = document.getElementById('api-test-method');
const apiTestUrl = document.getElementById('api-test-url');
const apiTestSendBtn = document.getElementById('api-test-send-btn');
const apiTestBodyContainer = document.getElementById('api-test-body-container');
const apiTestBody = document.getElementById('api-test-body');
const apiTestResponseDrawer = document.getElementById('api-test-response-drawer');
const apiTestStatus = document.getElementById('api-test-status');
const apiTestTime = document.getElementById('api-test-time');
const apiTestResponseBody = document.getElementById('api-test-response-body');
const downloadCodeBtn = document.getElementById('download-code-btn');
const exportGithubBtn = document.getElementById('export-github-btn');
const exportAdrBtn = document.getElementById('export-adr-btn');
const exportSlackBtn = document.getElementById('export-slack-btn');

// Initialize Mermaid.js for dark-mode architecture diagrams
if (typeof mermaid !== 'undefined') {
    try {
        mermaid.initialize({
            startOnLoad: false,
            theme: 'dark',
            securityLevel: 'loose',
            themeVariables: {
                darkMode: true,
                background: '#0a0a0a',
                primaryColor: '#2e5bff',
                primaryTextColor: '#f2f2f7',
                primaryBorderColor: '#2e5bff',
                lineColor: '#00e639',
                secondaryColor: '#1f1f1f',
                tertiaryColor: '#131313'
            }
        });
    } catch (e) {
        console.warn('Mermaid initialization warning:', e);
    }
}

let currentSessionId = localStorage.getItem('vak_session_id') || ('web_' + Math.random().toString(36).substring(2, 15));
localStorage.setItem('vak_session_id', currentSessionId);

let currentActionPlan = null;
let activeTab = 'dialogue'; // 'dialogue' | 'action'

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeQuote(str) {
    if (!str) return '';
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function directToAgentForTask(taskText) {
    switchTab('dialogue');
    const prompt = `Let's work on this task: "${taskText}". What do you need from me to spec this out and execute it?`;
    if (textInput) {
        textInput.value = prompt;
        textInput.focus();
    }
    sendText(prompt);
}
window.directToAgentForTask = directToAgentForTask;
window.escapeHtml = escapeHtml;
window.escapeQuote = escapeQuote;

// ── SPA View Switcher ──
function switchView(viewId) {
    const views = ['home', 'about', 'chat'];
    views.forEach(v => {
        const viewEl = document.getElementById(`view-${v}`);
        const navEl = document.getElementById(`nav-${v}`);
        if (v === viewId) {
            viewEl.classList.add('active');
            if (navEl) {
                navEl.className = 'text-electric-blue font-bold border-b-2 border-electric-blue pb-1 font-label-mono-sm text-label-mono-sm uppercase transition-all duration-300';
            }
        } else {
            viewEl.classList.remove('active');
            if (navEl) {
                navEl.className = 'text-white/60 font-medium font-label-mono-sm text-label-mono-sm uppercase hover:text-white transition-all duration-300';
            }
        }
    });

    // Pause Kanye music when user starts entering the voice terminal (Chat page)
    if (viewId === 'chat') {
        pauseKanyeMusic();
        // Initialize WebSocket connection when entering Chat view
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            connectWS();
        } else {
            fetchSessions();
        }
    }
}

// ── Kanye West Instrumental Pill ──
kanyeAudio.volume = 0.15; // Set backing track low to avoid overpowering voice agent

function toggleKanyeMusic() {
    if (kanyePlaying) {
        pauseKanyeMusic();
    } else {
        playKanyeMusic();
    }
}

function playKanyeMusic() {
    // Prevent background music playing on Chat terminal view
    const activeView = document.querySelector('.view-content.active');
    if (activeView && activeView.id === 'view-chat') {
        return;
    }

    kanyeAudio.play().then(() => {
        kanyePlaying = true;
        const playSvg = document.getElementById('svg-play');
        const pauseSvg = document.getElementById('svg-pause');
        if (playSvg) playSvg.classList.add('hidden');
        if (pauseSvg) pauseSvg.classList.remove('hidden');
        animateVisualizer(true);
    }).catch(err => {
        console.warn('Playback blocked or failed:', err);
    });
}

function pauseKanyeMusic() {
    kanyeAudio.pause();
    kanyePlaying = false;
    const playSvg = document.getElementById('svg-play');
    const pauseSvg = document.getElementById('svg-pause');
    if (playSvg) playSvg.classList.remove('hidden');
    if (pauseSvg) pauseSvg.classList.add('hidden');
    animateVisualizer(false);
}

function animateVisualizer(active) {
    const bars = kanyeVisualizer.querySelectorAll('div');
    bars.forEach((bar, index) => {
        if (active) {
            bar.classList.add('visualizer-bar-active');
            bar.style.animationDelay = `${index * 0.1}s`;
        } else {
            bar.classList.remove('visualizer-bar-active');
        }
    });
}

kanyePlayBtn.addEventListener('click', toggleKanyeMusic);

// ── HUD Dynamic Clock ──
function updateClock() {
    const now = new Date();
    // Time format: "02:15 PM"
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    // Date format: "THURSDAY, 6/11/2026"
    const weekday = now.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
    const dateStr = `${weekday}, ${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;

    const hudTime = document.getElementById('current-time-hud');
    const footerTime = document.getElementById('footer-time');
    const footerDate = document.getElementById('footer-date');

    if (hudTime) hudTime.textContent = timeStr;
    if (footerTime) footerTime.textContent = timeStr;
    if (footerDate) footerDate.textContent = dateStr;
}
setInterval(updateClock, 1000);
updateClock();

function connectWS() {
    // Retrieve or generate a persistent session ID
    let sessionId = localStorage.getItem('vak_session_id');
    if (!sessionId) {
        sessionId = 'web_' + Math.random().toString(36).substring(2, 15);
        localStorage.setItem('vak_session_id', sessionId);
    }
    currentSessionId = sessionId;

    ws = new WebSocket(`${WS_URL}/ws/voice?session_id=${sessionId}`);

    ws.onopen = () => {
        if (wsDot) wsDot.className = 'w-2.5 h-2.5 rounded-full bg-status-green pulse-ring relative';
        if (wsStatus) wsStatus.textContent = `connected (session: ${sessionId.substring(0, 8)})`;
        setState('idle');
        fetchHealth();
        fetchSessions();

        if (pendingSendText) {
            const queued = pendingSendText;
            pendingSendText = null;
            setState('thinking');
            ws.send(JSON.stringify({
                type: 'text',
                text: queued
            }));
        }
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'session_init') {
            loadVault();
            // Load user insights
            renderInsights(msg.insights);
            if (msg.action_plan) {
                saveDeliverable(msg.action_plan);
                renderActionPlan(msg.action_plan);
            }

            // Clean up and load transcripts
            transcriptArea.innerHTML = '';
            if (msg.history && msg.history.length > 0) {
                msg.history.forEach(item => {
                    if (item.role !== 'system') {
                        addTranscriptBubble(item.role, item.content);
                    }
                });
                const viewReportBtn = document.getElementById('view-report-btn');
                if (viewReportBtn) viewReportBtn.classList.remove('hidden');
            } else {
                transcriptArea.innerHTML = '<div class="text-white/40 font-label-mono-xs uppercase tracking-widest text-center mt-8 select-none">// START SESSION TO ENGAGE DIALOGUE</div>';
                const viewReportBtn = document.getElementById('view-report-btn');
                if (viewReportBtn) viewReportBtn.classList.add('hidden');
            }
        }
        else if (msg.type === 'transcript') {
            // Append incoming transcripts in real-time
            if (msg.role === 'user') {
                // Deduplicate if already added locally
                const existingBubbles = transcriptArea.querySelectorAll('.bg-electric-blue\\/10');
                let found = false;
                existingBubbles.forEach(b => {
                    if (b.textContent.trim() === msg.text.trim()) found = true;
                });
                if (!found) {
                    currentAssistantBubble = null;
                    addTranscriptBubble('user', msg.text);
                }
            } else if (msg.role === 'assistant') {
                appendAssistantSentence(msg.text);
            }
        }
        else if (msg.type === 'insights') {
            // Background update received from insights analyzer
            renderInsights(msg.data);
            flashInsightsSnippet();
        }
        else if (msg.type === 'action_plan') {
            // Structured Agentic Action Plan received
            saveDeliverable(msg.data);
            renderActionPlan(msg.data);
            appendDeliverableCardToChat(msg.data);
            pendingActionRedirect = true;
        }
        else if (msg.type === 'audio') {
            // Decode base64 audio and queue for playback
            const audioBytes = base64ToArrayBuffer(msg.data);
            audioQueue.push(audioBytes);
            if (!isPlaying) {
                setState('speaking');
                playNextChunk();
            }
        }
        else if (msg.type === 'metrics') {
            // Update HUD Timings
            if (metricStt) metricStt.textContent = msg.stt_ms > 0 ? `${msg.stt_ms.toFixed(0)} ms` : '0 ms';
            if (metricLlm) metricLlm.textContent = `${msg.llm_ms.toFixed(0)} ms`;
            if (metricTts) metricTts.textContent = `${msg.tts_ms.toFixed(0)} ms`;
        }
        else if (msg.type === 'done') {
            // Stream complete
            if (!isPlaying && audioQueue.length === 0) {
                setState('idle');
                currentAssistantBubble = null;
            }
            const viewReportBtn = document.getElementById('view-report-btn');
            if (viewReportBtn) viewReportBtn.classList.remove('hidden');
            fetchSessions(); // Dynamic refresh after exchange is complete and saved

            // Automatic redirection to generated deliverable in Action Deck
            if (pendingActionRedirect) {
                showRedirectToast('⚡ DELIVERABLE READY: REDIRECTING TO ACTION DECK...');
                setTimeout(() => {
                    if (pendingActionRedirect) {
                        switchTab('action');
                        pendingActionRedirect = false;
                    }
                }, 1300);
            }
        }
    };

    ws.onclose = () => {
        if (wsDot) wsDot.className = 'w-2.5 h-2.5 rounded-full bg-red-500 pulse-ring relative';
        if (wsStatus) wsStatus.textContent = 'disconnected';
        setState('idle');
        // Auto-reconnect after 2s
        setTimeout(connectWS, 2000);
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };
}

// ── Audio Playback ──
async function playNextChunk() {
    if (audioQueue.length === 0) {
        isPlaying = false;
        setState('idle');
        return;
    }

    isPlaying = true;

    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        try {
            await audioContext.resume();
        } catch (e) {
            console.warn('AudioContext resume failed:', e);
        }
    }

    const chunk = audioQueue.shift();

    try {
        const audioBuffer = await audioContext.decodeAudioData(chunk.slice(0));
        const source = audioContext.createBufferSource();
        activeAudioSource = source;
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);
        source.onended = () => {
            if (activeAudioSource === source) {
                activeAudioSource = null;
            }
            playNextChunk();
        };
        source.start();
    } catch (e) {
        console.error('Audio decode error:', e);
        playNextChunk(); // Skip bad chunk
    }
}

// ── Mic Recording (Push-to-Talk & Tap-to-Talk) ──
let micStream = null;

async function startRecording() {
    // Automatically suspend background Kanye music on voice interaction
    pauseKanyeMusic();
    stopAssistantSpeaking();

    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        try {
            await audioContext.resume();
        } catch (e) {
            console.warn('AudioContext resume failed:', e);
        }
    }

    try {
        // 1. Request microphone with resilient constraint fallback
        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                }
            });
        } catch (err) {
            console.warn('Standard getUserMedia constraints failed, trying basic audio: true', err);
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        micStream = stream;

        // 2. Cross-browser MIME type selection (Safari uses audio/mp4, Chrome uses audio/webm)
        let selectedMime = '';
        const preferredTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/mp4',
            'audio/aac',
            'audio/ogg'
        ];

        if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
            for (const t of preferredTypes) {
                if (MediaRecorder.isTypeSupported(t)) {
                    selectedMime = t;
                    break;
                }
            }
        }

        const recorderOptions = selectedMime ? { mimeType: selectedMime } : {};
        mediaRecorder = new MediaRecorder(stream, recorderOptions);
        const actualMime = mediaRecorder.mimeType || selectedMime || 'audio/webm';

        audioChunks = [];

        mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
            const blob = new Blob(audioChunks, { type: actualMime });

            try {
                // Convert recorded audio to 16kHz WAV mono
                const wavBlob = await convertToWav(blob);
                const arrayBuffer = await wavBlob.arrayBuffer();
                const base64 = arrayBufferToBase64(arrayBuffer);

                // Send to backend
                if (ws && ws.readyState === WebSocket.OPEN) {
                    setState('thinking');
                    ws.send(JSON.stringify({
                        type: 'audio',
                        data: base64
                    }));
                } else {
                    setState('idle');
                }
            } catch (e) {
                console.error('Failed to process/send audio:', e);
                setState('idle');
            } finally {
                // Stop all tracks
                if (micStream) {
                    micStream.getTracks().forEach(t => t.stop());
                    micStream = null;
                }
            }
        };

        mediaRecorder.start(250);
        isRecording = true;
        setState('listening');
    } catch (e) {
        console.error('Mic error:', e);
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
            voiceStateText.textContent = 'MIC PERMISSION DENIED (CHECK BROWSER PRIVACY)';
        } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
            voiceStateText.textContent = 'NO MICROPHONE HARDWARE DETECTED';
        } else if (e.name === 'NotSupportedError') {
            voiceStateText.textContent = 'AUDIO RECORDING NOT SUPPORTED IN THIS BROWSER';
        } else if (e.name === 'OverconstrainedError') {
            voiceStateText.textContent = 'MIC HARDWARE CONSTRAINT ERROR';
        } else {
            voiceStateText.textContent = `MIC ERROR: ${e.name || e.message || 'FAILED'}`;
        }
        voiceStateText.className = 'font-label-mono-sm text-label-mono-sm uppercase text-red-500 tracking-widest select-none';
    }
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        try {
            mediaRecorder.stop();
        } catch (e) {
            console.error('Error stopping recorder:', e);
        }
        isRecording = false;
    }
}

// ── WAV Conversion ──
async function convertToWav(blob) {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    const arrayBuffer = await blob.arrayBuffer();
    
    // Cross-browser decode supporting Promise and callback forms
    const audioBuffer = await new Promise((resolve, reject) => {
        audioContext.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
    });

    // Resample to 16kHz mono
    const targetLength = Math.max(1, Math.round(audioBuffer.duration * 16000));
    const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, targetLength, 16000);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);

    const rendered = await offlineCtx.startRendering();
    const samples = rendered.getChannelData(0);

    // Encode WAV
    return encodeWav(samples, 16000);
}

function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    // WAV header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    // PCM data
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s * 0x7fff, true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// ── Text messaging ──
let pendingSendText = null;

function sendText(text) {
    const cleanText = text ? text.trim() : '';
    if (!cleanText) return;

    pauseKanyeMusic();
    stopAssistantSpeaking();

    // Ensure user immediately sees dialogue tab and their prompt
    switchTab('dialogue');

    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        try {
            audioContext.resume();
        } catch (e) {
            console.warn('AudioContext resume failed:', e);
        }
    }

    // Immediately display user message in the dialogue transcript
    addTranscriptBubble('user', cleanText);
    textInput.value = '';

    // If WebSocket is not open, connect and queue message
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('WebSocket not open (state: ' + (ws ? ws.readyState : 'null') + '). Queueing text and connecting...');
        pendingSendText = cleanText;
        if (!ws || ws.readyState === WebSocket.CLOSED) {
            connectWS();
        }
        setState('thinking');
        return;
    }

    currentAssistantBubble = null; // reset active response block
    setState('thinking');

    ws.send(JSON.stringify({
        type: 'text',
        text: cleanText
    }));
}

// ── UI Rendering Helpers ──
function setState(state) {
    currentState = state;

    // Reset styles
    orb1.className = 'absolute inset-0 rounded-full border scale-100 opacity-60 transition-all duration-700';
    orb2.className = 'absolute inset-0 rounded-full border scale-100 opacity-40 transition-all duration-700 pulse-ring';
    liveMicBtn.className = 'w-32 h-32 rounded-full bg-black border border-white/10 flex flex-col items-center justify-center relative z-20 group hover:border-electric-blue hover:shadow-[0_0_20px_rgba(46,91,255,0.25)] transition-all duration-300 active:scale-95 cursor-pointer';
    micIcon.className = 'material-symbols-outlined text-[36px] text-white transition-all group-hover:text-electric-blue';

    if (state === 'idle') {
        orb1.classList.add('border-electric-blue/30');
        orb2.classList.add('border-electric-blue/15');
        micIcon.textContent = 'mic';
        micLabel.textContent = 'TAP TO SPEAK';
        voiceStateText.textContent = 'SYS_READY // READY TO SHIFT';
        voiceStateText.className = 'font-label-mono-sm text-label-mono-sm uppercase text-white/90 tracking-widest select-none';
    }
    else if (state === 'listening') {
        orb1.classList.add('border-red-500/50', 'scale-110');
        orb2.classList.add('border-red-500/30');
        liveMicBtn.classList.add('border-red-500', 'shadow-[0_0_25px_rgba(239,68,68,0.4)]');
        micIcon.textContent = 'graphic_eq';
        micIcon.classList.add('text-red-500');
        micLabel.textContent = 'RECORDING';
        voiceStateText.textContent = 'LISTENING // STREAMING SPEECH';
        voiceStateText.className = 'font-label-mono-sm text-label-mono-sm uppercase text-red-500 tracking-widest select-none animate-pulse';
    }
    else if (state === 'thinking') {
        orb1.classList.add('border-electric-blue', 'animate-rotate');
        orb2.classList.add('border-transparent');
        liveMicBtn.classList.add('border-electric-blue/40');
        micIcon.textContent = 'hourglass_empty';
        micIcon.classList.add('text-electric-blue');
        micLabel.textContent = 'THINKING';
        voiceStateText.textContent = 'THINKING // INGESTING INPUT';
        voiceStateText.className = 'font-label-mono-sm text-label-mono-sm uppercase text-electric-blue tracking-widest select-none';
    }
    else if (state === 'speaking') {
        orb1.classList.add('border-status-green/50', 'scale-105');
        orb2.classList.add('border-status-green/30');
        liveMicBtn.classList.add('border-status-green', 'shadow-[0_0_25px_rgba(0,255,65,0.3)]');
        micIcon.textContent = 'volume_up';
        micIcon.classList.add('text-status-green');
        micLabel.textContent = 'SPEAKING';
        voiceStateText.textContent = 'SPEAKING // VĀK REFLECTING';
        voiceStateText.className = 'font-label-mono-sm text-label-mono-sm uppercase text-status-green tracking-widest select-none';
    }
}

function addTranscriptBubble(role, text) {
    // Remove empty placeholder message if present
    if (transcriptArea.querySelector('.select-none')) {
        transcriptArea.innerHTML = '';
    }

    const bubble = document.createElement('div');
    if (role === 'user') {
        bubble.className = 'flex flex-col items-end gap-1 w-full animate-pulse';
        bubble.innerHTML = `
            <span class="font-label-mono-xs text-[9px] text-electric-blue uppercase">// USER</span>
            <div class="bg-electric-blue/10 border border-electric-blue/20 px-4 py-2.5 text-white max-w-[85%] text-right font-body-md text-sm leading-relaxed">
                ${text}
            </div>
        `;
        // Remove pulse after layout settles
        setTimeout(() => bubble.classList.remove('animate-pulse'), 800);
    } else {
        bubble.className = 'flex flex-col items-start gap-1 w-full';
        bubble.innerHTML = `
            <span class="font-label-mono-xs text-[9px] text-status-green uppercase">// VĀK</span>
            <div class="bg-white/5 border border-white/10 px-4 py-2.5 text-white max-w-[85%] font-body-md text-sm leading-relaxed assistant-bubble-text">
                ${text}
            </div>
        `;
    }

    transcriptArea.appendChild(bubble);
    transcriptArea.scrollTop = transcriptArea.scrollHeight;
}

function appendAssistantSentence(text) {
    if (transcriptArea.querySelector('.select-none')) {
        transcriptArea.innerHTML = '';
    }

    if (!currentAssistantBubble) {
        // Create new assistant response container
        const bubble = document.createElement('div');
        bubble.className = 'flex flex-col items-start gap-1 w-full';
        bubble.innerHTML = `
            <span class="font-label-mono-xs text-[9px] text-status-green uppercase">// VĀK</span>
            <div class="bg-white/5 border border-white/10 px-4 py-2.5 text-white max-w-[85%] font-body-md text-sm leading-relaxed assistant-bubble-text">
                ${text}
            </div>
        `;
        transcriptArea.appendChild(bubble);
        currentAssistantBubble = bubble.querySelector('.assistant-bubble-text');
    } else {
        // Append sentence to active bubble
        currentAssistantBubble.textContent += ' ' + text;
    }

    transcriptArea.scrollTop = transcriptArea.scrollHeight;
}

function renderInsights(insights) {
    if (!insights || Object.keys(insights).length === 0) {
        insightsContent.innerHTML = 'Calibrating remote user posture. Say something to start.';
        insightsSnippet.classList.add('hidden');
        return;
    }

    let html = '';
    if (insights.recurring_avoidances && insights.recurring_avoidances.length > 0) {
        html += `<div><span class="text-electric-blue font-semibold">AVOIDANCES:</span> ${insights.recurring_avoidances.join(', ')}</div>`;
    }
    if (insights.emotional_triggers && insights.emotional_triggers.length > 0) {
        html += `<div><span class="text-electric-blue font-semibold">TRIGGERS:</span> ${insights.emotional_triggers.join(', ')}</div>`;
    }
    if (insights.philosophy_alignment) {
        html += `<div class="mt-1"><span class="text-electric-blue font-semibold">POSTURE:</span> ${insights.philosophy_alignment}</div>`;
    }
    if (insights.key_people && Object.keys(insights.key_people).length > 0) {
        const peopleStr = Object.entries(insights.key_people).map(([name, desc]) => `${name} (${desc})`).join(', ');
        html += `<div class="mt-1"><span class="text-electric-blue font-semibold">RELATIONSHIPS:</span> ${peopleStr}</div>`;
    }

    insightsContent.innerHTML = html || 'Profile calibrated.';
    insightsSnippet.classList.remove('hidden');
}

function flashInsightsSnippet() {
    insightsSnippet.classList.add('border-electric-blue', 'shadow-[0_0_15px_rgba(46,91,255,0.2)]');
    setTimeout(() => {
        insightsSnippet.classList.remove('border-electric-blue', 'shadow-[0_0_15px_rgba(46,91,255,0.2)]');
    }, 1500);
}

// ── Agentic Action Deck & Vault Logic ──
let sessionDeliverables = [];
let pendingActionRedirect = false;

function loadVault() {
    try {
        const stored = localStorage.getItem('vak_vault_' + currentSessionId);
        sessionDeliverables = stored ? JSON.parse(stored) : [];
    } catch (e) {
        sessionDeliverables = [];
    }
    renderVault();
}

function saveDeliverable(plan) {
    if (!plan || !plan.tasks || plan.tasks.length === 0) return;
    const title = plan.title || 'WORK ORDER';
    const existingIdx = sessionDeliverables.findIndex(d => d.title === title);

    const deliverable = {
        id: existingIdx >= 0 ? sessionDeliverables[existingIdx].id : 'deliv_' + Date.now(),
        title: title,
        objective: plan.objective || '',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        date: new Date().toLocaleDateString([], { month: 'short', day: 'numeric' }),
        plan: JSON.parse(JSON.stringify(plan)),
        hasDiagram: !!(plan.diagram && plan.diagram.trim()),
        hasCode: !!(plan.code_snippet && plan.code_snippet.code),
        hasApi: !!(plan.api_endpoint && plan.api_endpoint.url),
        tasksCount: (plan.tasks || []).length
    };

    if (existingIdx >= 0) {
        sessionDeliverables[existingIdx] = deliverable;
    } else {
        sessionDeliverables.unshift(deliverable);
    }

    try {
        localStorage.setItem('vak_vault_' + currentSessionId, JSON.stringify(sessionDeliverables));
    } catch (e) {
        console.warn('Failed to save vault to localStorage:', e);
    }

    renderVault();
}

function deleteDeliverable(id, event) {
    if (event) event.stopPropagation();
    sessionDeliverables = sessionDeliverables.filter(d => d.id !== id);
    try {
        localStorage.setItem('vak_vault_' + currentSessionId, JSON.stringify(sessionDeliverables));
    } catch (e) {
        console.warn('Failed to delete deliverable from localStorage:', e);
    }
    renderVault();
}
window.deleteDeliverable = deleteDeliverable;

function showRedirectToast(message) {
    const existing = document.getElementById('redirect-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'redirect-toast';
    toast.className = 'fixed top-4 right-4 z-50 bg-black/95 border border-electric-blue text-white px-4 py-2.5 font-mono text-xs flex items-center gap-3 shadow-[0_0_25px_rgba(46,91,255,0.45)] animate-bounce';
    toast.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-electric-blue animate-ping"></span>
        <span class="tracking-wider uppercase text-[10px]">${escapeHtml(message)}</span>
        <button onclick="switchTab('action'); this.parentElement.remove();" class="px-2 py-0.5 bg-electric-blue text-white font-bold text-[9px] uppercase hover:bg-electric-blue/80 cursor-pointer">VIEW NOW →</button>
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
        if (toast && toast.parentElement) toast.remove();
    }, 4500);
}
window.showRedirectToast = showRedirectToast;

function appendDeliverableCardToChat(plan) {
    if (!plan) return;
    const title = plan.title || 'WORK ORDER DELIVERABLE';
    let typeIcon = 'schema';
    let typeName = 'DELIVERABLE READY';
    if (plan.diagram) {
        typeIcon = 'schema';
        typeName = 'ARCHITECTURE DIAGRAM';
    } else if (plan.code_snippet && plan.code_snippet.code) {
        typeIcon = 'code';
        typeName = 'CODE BLUEPRINT';
    } else if (plan.api_endpoint && plan.api_endpoint.url) {
        typeIcon = 'send';
        typeName = 'API TEST RUNNER';
    }

    const card = document.createElement('div');
    card.className = 'mt-3 p-3 bg-electric-blue/10 border border-electric-blue/40 flex items-center justify-between gap-3 animate-fade-in select-none';
    card.innerHTML = `
        <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-8 h-8 rounded bg-electric-blue/20 border border-electric-blue/50 flex items-center justify-center flex-shrink-0">
                <span class="material-symbols-outlined text-electric-blue text-sm animate-pulse">${typeIcon}</span>
            </div>
            <div class="min-w-0">
                <div class="flex items-center gap-1.5">
                    <span class="text-[8px] uppercase tracking-wider text-green-400 font-mono font-bold">${typeName}</span>
                    <span class="text-[8px] text-white/40 font-mono">• STORED IN WORK DONE</span>
                </div>
                <div class="font-mono text-xs text-white font-bold truncate">${escapeHtml(title)}</div>
            </div>
        </div>
        <button onclick="switchTab('action')" class="px-3 py-1.5 bg-electric-blue hover:bg-electric-blue/80 text-white font-mono text-[9px] uppercase font-bold tracking-wider transition-colors flex items-center gap-1 cursor-pointer flex-shrink-0 shadow-[0_0_10px_rgba(46,91,255,0.4)]">
            <span>VIEW PRODUCT</span>
            <span class="material-symbols-outlined text-xs">arrow_forward</span>
        </button>
    `;

    if (currentAssistantBubble) {
        currentAssistantBubble.appendChild(card);
    } else {
        const wrapper = document.createElement('div');
        wrapper.className = 'flex justify-start';
        const bubble = document.createElement('div');
        bubble.className = 'max-w-[85%] border border-white/10 bg-black/60 p-3.5 space-y-1';
        bubble.innerHTML = `<div class="font-label-mono-xs text-[9px] text-white/40 uppercase mb-1">// VĀK EXECUTOR</div>`;
        bubble.appendChild(card);
        wrapper.appendChild(bubble);
        transcriptArea.appendChild(wrapper);
    }
    transcriptArea.scrollTop = transcriptArea.scrollHeight;
}
window.appendDeliverableCardToChat = appendDeliverableCardToChat;

function renderVault() {
    const vaultList = document.getElementById('vault-list');
    const vaultEmpty = document.getElementById('vault-empty');
    const vaultBadge = document.getElementById('vault-count-badge');
    const vaultTabCount = document.getElementById('vault-items-count');
    const overviewRecent = document.getElementById('overview-recent-deliverables');
    const overviewRecentList = document.getElementById('overview-recent-deliverables-list');
    const resumeBtn = document.getElementById('deck-resume-header-btn');

    const count = sessionDeliverables.length;
    if (vaultBadge) vaultBadge.textContent = `${count} DELIVERABLE${count === 1 ? '' : 'S'}`;
    if (vaultTabCount) {
        vaultTabCount.textContent = count;
        if (count > 0) vaultTabCount.classList.remove('hidden');
        else vaultTabCount.classList.add('hidden');
    }

    if (resumeBtn) {
        if (count > 0 && actionDeckContent && actionDeckContent.classList.contains('hidden')) {
            resumeBtn.classList.remove('hidden');
        } else {
            resumeBtn.classList.add('hidden');
        }
    }

    if (!sessionDeliverables || sessionDeliverables.length === 0) {
        if (vaultEmpty) vaultEmpty.classList.remove('hidden');
        if (vaultList) vaultList.classList.add('hidden');
        if (overviewRecent) overviewRecent.classList.add('hidden');
        return;
    }

    if (vaultEmpty) vaultEmpty.classList.add('hidden');
    if (vaultList) {
        vaultList.classList.remove('hidden');
        vaultList.innerHTML = sessionDeliverables.map((item, idx) => {
            let tagsHtml = '';
            if (item.hasDiagram) tagsHtml += `<span class="px-1.5 py-0.5 bg-electric-blue/10 text-electric-blue border border-electric-blue/30 text-[8px] uppercase tracking-wider flex items-center gap-1"><span class="material-symbols-outlined text-[10px]">schema</span>DIAGRAM</span>`;
            if (item.hasCode) tagsHtml += `<span class="px-1.5 py-0.5 bg-green-500/10 text-green-400 border border-green-500/30 text-[8px] uppercase tracking-wider flex items-center gap-1"><span class="material-symbols-outlined text-[10px]">code</span>BLUEPRINT</span>`;
            if (item.hasApi) tagsHtml += `<span class="px-1.5 py-0.5 bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 text-[8px] uppercase tracking-wider flex items-center gap-1"><span class="material-symbols-outlined text-[10px]">send</span>API TEST</span>`;
            tagsHtml += `<span class="px-1.5 py-0.5 bg-white/5 text-white/50 border border-white/10 text-[8px] uppercase tracking-wider">${item.tasksCount} TASKS</span>`;

            return `
                <div class="p-3.5 bg-black/80 border border-white/10 hover:border-electric-blue/50 transition-all space-y-2.5 group">
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                            <div class="flex items-center gap-2 mb-1">
                                <span class="font-mono text-[9px] text-white/40">// DELIVERABLE #${sessionDeliverables.length - idx}</span>
                                <span class="font-mono text-[8px] text-white/30">${item.date} ${item.timestamp}</span>
                            </div>
                            <h4 class="font-mono text-xs text-white uppercase font-bold group-hover:text-electric-blue transition-colors truncate">${escapeHtml(item.title)}</h4>
                            <p class="text-[10px] text-white/60 leading-relaxed mt-0.5 line-clamp-2">${escapeHtml(item.objective)}</p>
                        </div>
                        <div class="flex items-center gap-1.5 flex-shrink-0">
                            <button onclick="restoreDeliverable('${item.id}')" class="px-2.5 py-1 bg-electric-blue/10 hover:bg-electric-blue text-electric-blue hover:text-white border border-electric-blue/40 text-[9px] uppercase tracking-wider font-mono flex items-center gap-1 transition-colors cursor-pointer">
                                <span>OPEN IN ACTION DECK</span>
                                <span class="material-symbols-outlined text-[11px]">arrow_forward</span>
                            </button>
                            <button onclick="deleteDeliverable('${item.id}', event)" class="p-1 text-white/30 hover:text-red-400 border border-transparent hover:border-red-500/30 transition-colors cursor-pointer" title="Delete deliverable">
                                <span class="material-symbols-outlined text-sm">delete</span>
                            </button>
                        </div>
                    </div>
                    <div class="flex items-center justify-between pt-1 border-t border-white/5">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            ${tagsHtml}
                        </div>
                        <div class="flex items-center gap-2">
                            ${item.hasCode && item.plan.code_snippet ? `
                                <button onclick="downloadFileBlob('${escapeQuote(item.plan.code_snippet.filename || 'code.txt')}', \`${escapeQuote(item.plan.code_snippet.code || '')}\`)" class="text-[8px] text-green-400 hover:underline uppercase font-mono cursor-pointer flex items-center gap-0.5">
                                    <span class="material-symbols-outlined text-[10px]">download</span>
                                    <span>FILE</span>
                                </button>
                            ` : ''}
                            ${item.hasDiagram && item.plan.diagram ? `
                                <button onclick="navigator.clipboard.writeText(\`${escapeQuote(item.plan.diagram)}\`); alert('Mermaid diagram copied!');" class="text-[8px] text-electric-blue hover:underline uppercase font-mono cursor-pointer flex items-center gap-0.5">
                                    <span class="material-symbols-outlined text-[10px]">content_copy</span>
                                    <span>MERMAID</span>
                                </button>
                            ` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    if (overviewRecent && overviewRecentList) {
        overviewRecent.classList.remove('hidden');
        const latest = sessionDeliverables[0];
        const others = sessionDeliverables.slice(1, 3);

        let overviewHtml = `
            <div class="p-2.5 bg-black/80 border border-electric-blue/50 flex items-center justify-between gap-3 shadow-[0_0_15px_rgba(46,91,255,0.12)]">
                <div class="min-w-0">
                    <div class="flex items-center gap-2 mb-0.5">
                        <span class="px-1.5 py-0.2 bg-electric-blue/20 text-electric-blue text-[8px] font-mono font-bold uppercase">LATEST DELIVERABLE</span>
                        <span class="text-white/40 text-[8px] font-mono">${latest.date} ${latest.timestamp}</span>
                    </div>
                    <div class="font-mono text-xs text-white font-bold truncate">${escapeHtml(latest.title)}</div>
                    <div class="text-[9px] text-white/60 truncate mt-0.5">${escapeHtml(latest.objective)}</div>
                </div>
                <button onclick="restoreDeliverable('${latest.id}')" class="px-3 py-1.5 bg-electric-blue hover:bg-electric-blue/80 text-white font-mono text-[9px] uppercase font-bold tracking-wider cursor-pointer flex-shrink-0 flex items-center gap-1 shadow-[0_0_10px_rgba(46,91,255,0.4)]">
                    <span>RESUME</span>
                    <span class="material-symbols-outlined text-xs">arrow_forward</span>
                </button>
            </div>
        `;

        if (others.length > 0) {
            overviewHtml += `<div class="space-y-1 pt-1">`;
            others.forEach(item => {
                overviewHtml += `
                    <div class="p-1.5 bg-black/60 border border-white/5 hover:border-white/20 flex items-center justify-between gap-2">
                        <div class="flex items-center gap-2 min-w-0">
                            <span class="w-1.5 h-1.5 rounded-full ${item.hasDiagram ? 'bg-electric-blue' : 'bg-green-400'} flex-shrink-0"></span>
                            <span class="text-white text-[10px] font-mono truncate">${escapeHtml(item.title)}</span>
                            <span class="text-white/30 text-[8px] font-mono flex-shrink-0">${item.timestamp}</span>
                        </div>
                        <button onclick="restoreDeliverable('${item.id}')" class="text-[8px] text-electric-blue hover:underline uppercase font-mono cursor-pointer flex-shrink-0">RESTORE →</button>
                    </div>
                `;
            });
            overviewHtml += `</div>`;
        }

        overviewRecentList.innerHTML = overviewHtml;
    }
}

function restoreDeliverable(id) {
    const item = sessionDeliverables.find(d => d.id === id);
    if (!item || !item.plan) return;
    renderActionPlan(item.plan);
    switchTab('action');
}
window.restoreDeliverable = restoreDeliverable;

function renderFallbackDiagram(mermaidStr, container) {
    if (!container) return;
    try {
        const lines = mermaidStr.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('graph') && !l.startsWith('flowchart') && !l.startsWith('subgraph') && !l.startsWith('end') && !l.startsWith('classDef'));
        
        let nodes = new Map();
        let edges = [];

        lines.forEach(line => {
            const parts = line.split(/-->|-.->|==>/);
            if (parts.length >= 2) {
                const fromRaw = parts[0].trim();
                const toRaw = parts[1].trim();

                let edgeLabel = '';
                let cleanToRaw = toRaw;
                if (toRaw.startsWith('|')) {
                    const pipeIdx = toRaw.indexOf('|', 1);
                    if (pipeIdx > 0) {
                        edgeLabel = toRaw.substring(1, pipeIdx).trim();
                        cleanToRaw = toRaw.substring(pipeIdx + 1).trim();
                    }
                }

                const parseNode = (raw) => {
                    const match = raw.match(/^([a-zA-Z0-9_-]+)(?:\[(.*?)\])?/);
                    if (match) {
                        const id = match[1];
                        const label = match[2] || id;
                        nodes.set(id, label.replace(/["']/g, ''));
                        return id;
                    }
                    return raw.replace(/["']/g, '');
                };

                const fromId = parseNode(fromRaw);
                const toId = parseNode(cleanToRaw);
                edges.push({ from: fromId, to: toId, label: edgeLabel });
            }
        });

        if (nodes.size === 0) {
            container.innerHTML = `<pre class="text-white/60 font-mono text-[9px] whitespace-pre-wrap p-2">${escapeHtml(mermaidStr)}</pre>`;
            return;
        }

        let html = `<div class="w-full space-y-3 py-2">`;
        html += `<div class="text-[8px] uppercase font-mono text-electric-blue tracking-widest flex items-center justify-between pb-1 border-b border-white/10">
            <span>// SYSTEM TOPOLOGY (RENDERED GRAPH)</span>
            <span class="text-white/40">${nodes.size} COMPONENTS</span>
        </div>`;
        
        html += `<div class="flex flex-col md:flex-row items-center justify-center gap-3 flex-wrap">`;
        nodes.forEach((label, id) => {
            const outgoing = edges.filter(e => e.from === id);
            const edgeDesc = outgoing.map(e => `→ ${e.label ? `[${e.label}] ` : ''}${nodes.get(e.to) || e.to}`).join('<br>');
            
            html += `
                <div class="p-3 bg-black border border-electric-blue/50 hover:border-electric-blue shadow-[0_0_15px_rgba(46,91,255,0.15)] flex flex-col items-center min-w-[140px] text-center">
                    <span class="text-[8px] text-electric-blue/70 font-mono uppercase mb-0.5">${id}</span>
                    <span class="text-white font-mono text-xs font-bold">${escapeHtml(label)}</span>
                    ${edgeDesc ? `<div class="mt-2 text-[8px] font-mono text-green-400 border-t border-white/10 pt-1 leading-snug">${edgeDesc}</div>` : ''}
                </div>
            `;
        });
        html += `</div></div>`;
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<pre class="text-white/60 font-mono text-[9px] whitespace-pre-wrap p-2">${escapeHtml(mermaidStr)}</pre>`;
    }
}

function switchTab(tab) {
    activeTab = tab;
    if (tab !== 'action') {
        pendingActionRedirect = false;
    }
    const tabDialogueBtn = document.getElementById('tab-dialogue-btn');
    const tabActionBtn = document.getElementById('tab-action-btn');
    const tabVaultBtn = document.getElementById('tab-vault-btn');
    const transcriptArea = document.getElementById('voice-transcript-area');
    const actionDeckArea = document.getElementById('action-deck-area');
    const vaultArea = document.getElementById('vault-area');

    if (transcriptArea) transcriptArea.classList.add('hidden');
    if (actionDeckArea) actionDeckArea.classList.add('hidden');
    if (vaultArea) vaultArea.classList.add('hidden');

    if (tabDialogueBtn) tabDialogueBtn.className = 'font-label-mono-xs uppercase tracking-wider text-[10px] px-2 py-1 text-white/50 hover:text-white border-b-2 border-transparent transition-colors flex items-center gap-1.5 cursor-pointer';
    if (tabActionBtn) tabActionBtn.className = 'font-label-mono-xs uppercase tracking-wider text-[10px] px-2 py-1 text-white/50 hover:text-white border-b-2 border-transparent transition-colors flex items-center gap-1.5 cursor-pointer';
    if (tabVaultBtn) tabVaultBtn.className = 'font-label-mono-xs uppercase tracking-wider text-[10px] px-2 py-1 text-white/50 hover:text-white border-b-2 border-transparent transition-colors flex items-center gap-1.5 cursor-pointer';

    if (tab === 'dialogue') {
        if (transcriptArea) transcriptArea.classList.remove('hidden');
        if (tabDialogueBtn) tabDialogueBtn.className = 'font-label-mono-xs uppercase tracking-wider text-[10px] px-2 py-1 text-white border-b-2 border-electric-blue transition-colors cursor-pointer flex items-center gap-1.5';
    } else if (tab === 'action') {
        if (actionDeckArea) actionDeckArea.classList.remove('hidden');
        if (tabActionBtn) tabActionBtn.className = 'font-label-mono-xs uppercase tracking-wider text-[10px] px-2 py-1 text-white border-b-2 border-electric-blue transition-colors flex items-center gap-1.5 cursor-pointer';
        renderVault();
    } else if (tab === 'vault') {
        if (vaultArea) vaultArea.classList.remove('hidden');
        if (tabVaultBtn) tabVaultBtn.className = 'font-label-mono-xs uppercase tracking-wider text-[10px] px-2 py-1 text-white border-b-2 border-green-400 transition-colors flex items-center gap-1.5 cursor-pointer';
        renderVault();
    }
}
if (tabDialogueBtn) tabDialogueBtn.addEventListener('click', () => switchTab('dialogue'));
if (tabActionBtn) tabActionBtn.addEventListener('click', () => switchTab('action'));
const tabVaultBtnEl = document.getElementById('tab-vault-btn');
if (tabVaultBtnEl) tabVaultBtnEl.addEventListener('click', () => switchTab('vault'));

function resumeLatestActionPlan() {
    if (currentActionPlan) {
        renderActionPlan(currentActionPlan);
    } else if (sessionDeliverables && sessionDeliverables.length > 0) {
        restoreDeliverable(sessionDeliverables[0].id);
    }
    switchTab('action');
}
window.resumeLatestActionPlan = resumeLatestActionPlan;

function resetActionDeckToOverview() {
    if (actionDeckContent) actionDeckContent.classList.add('hidden');
    if (actionDeckEmpty) actionDeckEmpty.classList.remove('hidden');
    const backBtn = document.getElementById('deck-back-header-btn');
    if (backBtn) backBtn.classList.add('hidden');
    const resumeBtn = document.getElementById('deck-resume-header-btn');
    if (resumeBtn && (currentActionPlan || (sessionDeliverables && sessionDeliverables.length > 0))) {
        resumeBtn.classList.remove('hidden');
    }
    renderVault();
    switchTab('action');
}
window.resetActionDeckToOverview = resetActionDeckToOverview;

function renderActionPlan(plan) {
    if (!plan || !plan.tasks || plan.tasks.length === 0) return;
    currentActionPlan = plan;
    saveDeliverable(plan);

    if (actionDeckEmpty) actionDeckEmpty.classList.add('hidden');
    if (actionDeckContent) actionDeckContent.classList.remove('hidden');
    const backBtn = document.getElementById('deck-back-header-btn');
    if (backBtn) backBtn.classList.remove('hidden');
    const resumeBtn = document.getElementById('deck-resume-header-btn');
    if (resumeBtn) resumeBtn.classList.add('hidden');

    if (actionPlanTitle) actionPlanTitle.textContent = plan.title || 'WORK ORDER';
    if (actionPlanObjective) actionPlanObjective.textContent = plan.objective || 'Active execution tasks';

    // ── 1. Architecture Diagram Visualizer (Mermaid.js with Fallback) ──
    if (actionDiagramContainer && actionDiagramRender) {
        if (plan.diagram && plan.diagram.trim()) {
            actionDiagramContainer.classList.remove('hidden');
            let cleanDiagram = plan.diagram.trim();
            if (cleanDiagram.startsWith('```')) {
                const lines = cleanDiagram.split('\n');
                if (lines[0].startsWith('```')) lines.shift();
                if (lines.length && lines[lines.length - 1].startsWith('```')) lines.pop();
                cleanDiagram = lines.join('\n').trim();
            }

            if (typeof mermaid !== 'undefined') {
                const renderId = 'mermaid-' + Math.floor(Math.random() * 1000000);
                try {
                    mermaid.render(renderId, cleanDiagram).then(({ svg }) => {
                        actionDiagramRender.innerHTML = svg;
                        const svgEl = actionDiagramRender.querySelector('svg');
                        if (svgEl) {
                            svgEl.classList.add('max-w-full', 'h-auto');
                            svgEl.style.maxHeight = '320px';
                        }
                    }).catch(err => {
                        console.warn('Mermaid render error, using fallback topology:', err);
                        renderFallbackDiagram(cleanDiagram, actionDiagramRender);
                    });
                } catch (err) {
                    console.warn('Mermaid exception, using fallback topology:', err);
                    renderFallbackDiagram(cleanDiagram, actionDiagramRender);
                }
            } else {
                renderFallbackDiagram(cleanDiagram, actionDiagramRender);
            }

            if (copyMermaidBtn) {
                copyMermaidBtn.onclick = () => {
                    navigator.clipboard.writeText(cleanDiagram).then(() => {
                        copyMermaidBtn.textContent = 'COPIED!';
                        setTimeout(() => copyMermaidBtn.textContent = 'COPY MERMAID', 1500);
                    });
                };
            }
        } else {
            actionDiagramContainer.classList.add('hidden');
        }
    }


    // ── 2. Task Checklist with LocalStorage Persistence & Interactive Agent Directing ──
    if (actionTaskList) {
        const sessionPrefix = currentSessionId ? `vak_task_${currentSessionId}_` : 'vak_task_';
        actionTaskList.innerHTML = plan.tasks.map((task, idx) => {
            const taskId = task.id || `t${idx}`;
            const storedDone = localStorage.getItem(sessionPrefix + taskId);
            const isDone = storedDone !== null ? storedDone === 'true' : (task.status === 'done' || task.done);
            task.done = isDone;
            task.status = isDone ? 'done' : 'pending';

            const priorityClass = task.priority === 'high' ? 'text-red-400 border-red-500/30' : (task.priority === 'medium' ? 'text-yellow-400 border-yellow-500/30' : 'text-white/40 border-white/20');
            return `
                <div class="flex items-start gap-2.5 p-2 bg-black/60 border border-white/5 hover:border-white/20 transition-all group">
                    <input type="checkbox" id="task-chk-${idx}" class="mt-0.5 accent-electric-blue cursor-pointer rounded-none flex-shrink-0" ${isDone ? 'checked' : ''} onchange="toggleTaskDone(${idx})">
                    <div class="flex-grow cursor-pointer" onclick="directToAgentForTask('${escapeQuote(task.text)}')" title="Click to discuss this task with Vāk">
                        <span class="${isDone ? 'line-through text-white/40' : 'text-white/90 group-hover:text-electric-blue'} text-[11px] leading-snug">
                            ${escapeHtml(task.text)}
                        </span>
                    </div>
                    <button onclick="directToAgentForTask('${escapeQuote(task.text)}')" class="px-1.5 py-0.5 border border-electric-blue/40 bg-electric-blue/10 hover:bg-electric-blue hover:text-white text-electric-blue text-[8px] uppercase tracking-wider flex items-center gap-1 cursor-pointer flex-shrink-0 transition-colors" title="Ask Vāk to guide this task">
                        <span>DISCUSS</span>
                        <span class="material-symbols-outlined text-[10px]">arrow_forward</span>
                    </button>
                    <span class="px-1 py-0.2 border text-[7px] uppercase tracking-wider ${priorityClass} flex-shrink-0">${task.priority || 'TASK'}</span>
                </div>
            `;
        }).join('');
    }

    updateTaskProgress();

    // ── 3. CLI Commands ──
    if (actionCommandsContainer && actionCommandsList) {
        if (plan.commands && plan.commands.length > 0) {
            actionCommandsContainer.classList.remove('hidden');
            actionCommandsList.innerHTML = plan.commands.map((cmd) => `
                <div class="flex items-center justify-between gap-2 p-2 bg-black border border-white/10 font-mono text-[10px]">
                    <span class="text-green-400 truncate select-all">$ ${cmd}</span>
                    <button class="px-2 py-0.5 border border-white/20 hover:border-electric-blue text-white/70 hover:text-white text-[8px] uppercase tracking-wider transition-colors cursor-pointer flex-shrink-0" onclick="copyCommand('${cmd.replace(/'/g, "\\'")}', this)">COPY</button>
                </div>
            `).join('');
        } else {
            actionCommandsContainer.classList.add('hidden');
        }
    }

    // ── 4. In-Browser API & Endpoint Tester ──
    if (actionApiContainer) {
        if (plan.api_endpoint && plan.api_endpoint.url) {
            actionApiContainer.classList.remove('hidden');
            const ep = plan.api_endpoint;
            if (apiTestMethod) apiTestMethod.value = (ep.method || 'GET').toUpperCase();
            if (apiTestUrl) apiTestUrl.value = ep.url || '';
            if (apiTestBodyContainer && apiTestBody) {
                const isBodyMethod = ['POST', 'PUT', 'PATCH'].includes((ep.method || '').toUpperCase());
                if (isBodyMethod) {
                    apiTestBodyContainer.classList.remove('hidden');
                    apiTestBody.value = typeof ep.body === 'object' ? JSON.stringify(ep.body, null, 2) : (ep.body || '');
                } else {
                    apiTestBodyContainer.classList.add('hidden');
                }
            }
            if (apiTestResponseDrawer) apiTestResponseDrawer.classList.add('hidden');
            if (apiTestBadge) {
                apiTestBadge.textContent = 'READY';
                apiTestBadge.className = 'px-1.5 py-0.5 border border-white/10 text-[8px] text-electric-blue uppercase';
            }
        } else {
            actionApiContainer.classList.add('hidden');
        }
    }

    // ── 5. Code Blueprint & Direct Downloader ──
    if (actionCodeContainer && actionCodeBlock) {
        if (plan.code_snippet && plan.code_snippet.code) {
            actionCodeContainer.classList.remove('hidden');
            actionCodeBlock.textContent = plan.code_snippet.code;
            const filename = plan.code_snippet.filename || 'blueprint.txt';
            if (actionCodeFilename) {
                actionCodeFilename.textContent = `// ${filename.toUpperCase()}`;
            }

            if (downloadCodeBtn) {
                downloadCodeBtn.onclick = () => {
                    downloadFileBlob(filename, plan.code_snippet.code);
                    downloadCodeBtn.innerHTML = `<span class="material-symbols-outlined text-[12px]">check</span><span>DOWNLOADED!</span>`;
                    setTimeout(() => {
                        downloadCodeBtn.innerHTML = `<span class="material-symbols-outlined text-[12px]">download</span><span>DOWNLOAD FILE</span>`;
                    }, 2000);
                };
            }
        } else {
            actionCodeContainer.classList.add('hidden');
        }
    }

    // ── 6. Architecture Notes ──
    if (actionNotesContainer && actionNotesText) {
        if (plan.notes) {
            actionNotesContainer.classList.remove('hidden');
            actionNotesText.textContent = plan.notes;
        } else {
            actionNotesContainer.classList.add('hidden');
        }
    }

    // Update count badge on tab
    if (actionTaskCount) {
        actionTaskCount.textContent = plan.tasks.length;
        actionTaskCount.classList.remove('hidden');
    }

    // Reveal all exporters
    if (exportPlanBtn) exportPlanBtn.classList.remove('hidden');
    if (exportGithubBtn) exportGithubBtn.classList.remove('hidden');
    if (exportAdrBtn) exportAdrBtn.classList.remove('hidden');
    if (exportSlackBtn) exportSlackBtn.classList.remove('hidden');

    // Notify user on tab
    if (tabActionBtn) {
        tabActionBtn.classList.add('text-electric-blue', 'font-bold');
        setTimeout(() => {
            if (activeTab !== 'action') {
                tabActionBtn.classList.remove('text-electric-blue', 'font-bold');
            }
        }, 3000);
    }
}

function updateTaskProgress() {
    if (!currentActionPlan || !currentActionPlan.tasks) return;
    const total = currentActionPlan.tasks.length;
    const done = currentActionPlan.tasks.filter(t => t.status === 'done' || t.done).length;
    if (actionTaskProgress) actionTaskProgress.textContent = `${done}/${total} DONE`;
}

function toggleTaskDone(idx) {
    if (!currentActionPlan || !currentActionPlan.tasks[idx]) return;
    const task = currentActionPlan.tasks[idx];
    const isDone = task.status === 'done' || task.done;
    task.status = isDone ? 'pending' : 'done';
    task.done = !isDone;

    // Persist in localStorage
    const taskId = task.id || `t${idx}`;
    const sessionPrefix = currentSessionId ? `vak_task_${currentSessionId}_` : 'vak_task_';
    localStorage.setItem(sessionPrefix + taskId, task.done ? 'true' : 'false');

    renderActionPlan(currentActionPlan);
}

function copyCommand(cmd, btn) {
    navigator.clipboard.writeText(cmd).then(() => {
        const original = btn.textContent;
        btn.textContent = 'COPIED!';
        btn.classList.add('border-green-400', 'text-green-400');
        setTimeout(() => {
            btn.textContent = original;
            btn.classList.remove('border-green-400', 'text-green-400');
        }, 1500);
    });
}
window.copyCommand = copyCommand;
window.toggleTaskDone = toggleTaskDone;

// ── Native Browser File Downloader ──
function downloadFileBlob(filename, textContent) {
    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// ── In-Browser API Tester Execution ──
if (apiTestMethod) {
    apiTestMethod.addEventListener('change', () => {
        const isBodyMethod = ['POST', 'PUT', 'PATCH'].includes(apiTestMethod.value);
        if (apiTestBodyContainer) {
            if (isBodyMethod) apiTestBodyContainer.classList.remove('hidden');
            else apiTestBodyContainer.classList.add('hidden');
        }
    });
}

if (apiTestSendBtn) {
    apiTestSendBtn.addEventListener('click', async () => {
        const url = apiTestUrl ? apiTestUrl.value.trim() : '';
        const method = apiTestMethod ? apiTestMethod.value : 'GET';
        if (!url) return;

        if (apiTestBadge) {
            apiTestBadge.textContent = 'TESTING...';
            apiTestBadge.className = 'px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 text-[8px] uppercase animate-pulse';
        }

        const tStart = performance.now();
        try {
            const fetchOptions = {
                method: method,
                headers: { 'Accept': 'application/json' }
            };

            if (['POST', 'PUT', 'PATCH'].includes(method) && apiTestBody && apiTestBody.value.trim()) {
                fetchOptions.headers['Content-Type'] = 'application/json';
                fetchOptions.body = apiTestBody.value.trim();
            }

            const res = await fetch(url, fetchOptions);
            const duration = Math.round(performance.now() - tStart);

            let rawText = await res.text();
            let formattedText = rawText;
            try {
                const jsonObj = JSON.parse(rawText);
                formattedText = JSON.stringify(jsonObj, null, 2);
            } catch (_) {}

            if (apiTestResponseDrawer) apiTestResponseDrawer.classList.remove('hidden');
            if (apiTestStatus) {
                apiTestStatus.textContent = `STATUS: ${res.status} ${res.statusText || ''}`;
                apiTestStatus.className = res.ok ? 'text-green-400' : 'text-red-400';
            }
            if (apiTestTime) apiTestTime.textContent = `${duration} ms`;
            if (apiTestResponseBody) apiTestResponseBody.textContent = formattedText || '(empty response)';

            if (apiTestBadge) {
                apiTestBadge.textContent = res.ok ? `${res.status} OK` : `HTTP ${res.status}`;
                apiTestBadge.className = `px-1.5 py-0.5 ${res.ok ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'} text-[8px] uppercase`;
            }
        } catch (err) {
            const duration = Math.round(performance.now() - tStart);
            if (apiTestResponseDrawer) apiTestResponseDrawer.classList.remove('hidden');
            if (apiTestStatus) {
                apiTestStatus.textContent = 'ERROR: NETWORK / CORS BLOCKED';
                apiTestStatus.className = 'text-red-400';
            }
            if (apiTestTime) apiTestTime.textContent = `${duration} ms`;
            if (apiTestResponseBody) {
                apiTestResponseBody.textContent = `Failed to fetch: ${err.message}\nNote: If accessing a remote server, ensure CORS headers (Access-Control-Allow-Origin) are enabled.`;
            }
            if (apiTestBadge) {
                apiTestBadge.textContent = 'FAILED';
                apiTestBadge.className = 'px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[8px] uppercase';
            }
        }
    });
}

// ── Exporters (Plan, GitHub Issue, ADR, Slack Brief) ──
if (exportPlanBtn) {
    exportPlanBtn.addEventListener('click', () => {
        if (!currentActionPlan) return;
        let md = `# Work Order: ${currentActionPlan.title || 'Plan'}\n\n`;
        md += `> **Objective**: ${currentActionPlan.objective || ''}\n\n`;
        md += `## Tasks\n`;
        (currentActionPlan.tasks || []).forEach(t => {
            const check = (t.status === 'done' || t.done) ? '[x]' : '[ ]';
            md += `- ${check} [${(t.priority || 'task').toUpperCase()}] ${t.text}\n`;
        });
        if (currentActionPlan.commands && currentActionPlan.commands.length > 0) {
            md += `\n## Commands\n\`\`\`bash\n` + currentActionPlan.commands.join('\n') + `\n\`\`\`\n`;
        }
        if (currentActionPlan.code_snippet && currentActionPlan.code_snippet.code) {
            md += `\n## Code Blueprint (${currentActionPlan.code_snippet.filename || ''})\n\`\`\`${currentActionPlan.code_snippet.language || ''}\n${currentActionPlan.code_snippet.code}\n\`\`\`\n`;
        }
        if (currentActionPlan.notes) {
            md += `\n## Architecture Notes\n${currentActionPlan.notes}\n`;
        }
        navigator.clipboard.writeText(md).then(() => {
            if (exportBtnLabel) {
                exportBtnLabel.textContent = 'COPIED!';
                setTimeout(() => exportBtnLabel.textContent = 'PLAN', 1500);
            }
        });
    });
}

if (exportGithubBtn) {
    exportGithubBtn.addEventListener('click', () => {
        if (!currentActionPlan) return;
        let issueMd = `### Objective\n${currentActionPlan.objective || 'Implementation'}\n\n`;
        issueMd += `### Acceptance Checklist\n`;
        (currentActionPlan.tasks || []).forEach(t => {
            const check = (t.status === 'done' || t.done) ? '[x]' : '[ ]';
            issueMd += `- ${check} ${t.text} (${(t.priority || 'normal').toUpperCase()})\n`;
        });
        if (currentActionPlan.commands && currentActionPlan.commands.length > 0) {
            issueMd += `\n### Verification Commands\n\`\`\`bash\n${currentActionPlan.commands.join('\n')}\n\`\`\`\n`;
        }
        if (currentActionPlan.code_snippet && currentActionPlan.code_snippet.code) {
            issueMd += `\n### Blueprint: \`${currentActionPlan.code_snippet.filename || 'snippet'}\`\n\`\`\`${currentActionPlan.code_snippet.language || ''}\n${currentActionPlan.code_snippet.code}\n\`\`\`\n`;
        }
        if (currentActionPlan.notes) {
            issueMd += `\n> **Architectural Note**: ${currentActionPlan.notes}\n`;
        }

        navigator.clipboard.writeText(issueMd).then(() => {
            const orig = exportGithubBtn.innerHTML;
            exportGithubBtn.innerHTML = `<span class="material-symbols-outlined text-[12px]">check</span><span>COPIED!</span>`;
            setTimeout(() => exportGithubBtn.innerHTML = orig, 1500);
        });
    });
}

if (exportAdrBtn) {
    exportAdrBtn.addEventListener('click', () => {
        if (!currentActionPlan) return;
        const adrTitle = currentActionPlan.title || 'Architecture Decision';
        const dateStr = new Date().toISOString().split('T')[0];
        let adrMd = `# ADR: ${adrTitle}\n\n`;
        adrMd += `* **Status**: Accepted\n`;
        adrMd += `* **Date**: ${dateStr}\n`;
        adrMd += `* **Decision Maker**: vāk Technical Partner\n\n`;
        adrMd += `## Context\n${currentActionPlan.objective || 'Technical challenge discussed during session'}\n\n`;
        adrMd += `## Decision\n${currentActionPlan.notes || 'Implement structured solution as outlined in execution tasks.'}\n\n`;
        adrMd += `## Execution Tasks\n`;
        (currentActionPlan.tasks || []).forEach(t => {
            adrMd += `- [ ] ${t.text}\n`;
        });
        if (currentActionPlan.commands && currentActionPlan.commands.length > 0) {
            adrMd += `\n## CLI Verification\n\`\`\`bash\n${currentActionPlan.commands.join('\n')}\n\`\`\`\n`;
        }
        if (currentActionPlan.diagram) {
            adrMd += `\n## System Topology\n\`\`\`mermaid\n${currentActionPlan.diagram}\n\`\`\`\n`;
        }

        const safeFilename = `ADR-${dateStr}-${adrTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
        downloadFileBlob(safeFilename, adrMd);

        const orig = exportAdrBtn.innerHTML;
        exportAdrBtn.innerHTML = `<span class="material-symbols-outlined text-[12px]">check</span><span>SAVED!</span>`;
        setTimeout(() => exportAdrBtn.innerHTML = orig, 1500);
    });
}

if (exportSlackBtn) {
    exportSlackBtn.addEventListener('click', () => {
        if (!currentActionPlan) return;
        let slackText = `*vāk Action Brief: ${currentActionPlan.title || 'Work Order'}*\n`;
        slackText += `> ${currentActionPlan.objective || ''}\n`;
        const taskTexts = (currentActionPlan.tasks || []).slice(0, 3).map(t => `• ${t.text}`).join('\n');
        if (taskTexts) slackText += `\n*Key Next Steps:*\n${taskTexts}\n`;
        if (currentActionPlan.notes) slackText += `\n*Note:* ${currentActionPlan.notes}`;

        navigator.clipboard.writeText(slackText).then(() => {
            const orig = exportSlackBtn.innerHTML;
            exportSlackBtn.innerHTML = `<span class="material-symbols-outlined text-[12px]">check</span><span>COPIED!</span>`;
            setTimeout(() => exportSlackBtn.innerHTML = orig, 1500);
        });
    });
}

if (copyCodeBtn) {
    copyCodeBtn.addEventListener('click', () => {
        if (actionCodeBlock && actionCodeBlock.textContent) {
            navigator.clipboard.writeText(actionCodeBlock.textContent).then(() => {
                copyCodeBtn.textContent = 'COPIED!';
                setTimeout(() => copyCodeBtn.textContent = 'COPY CODE', 1500);
            });
        }
    });
}

// Quick action chips
document.querySelectorAll('.quick-chip').forEach(btn => {
    btn.addEventListener('click', () => {
        const prompt = btn.getAttribute('data-prompt');
        if (prompt) {
            textInput.value = prompt;
            sendText(prompt);
        }
    });
});


async function fetchHealth() {
    try {
        const res = await fetch(`${API_URL}/health`);
        const data = await res.json();
        const engines = data.engines || {};
        if (activeEnginesHud) {
            activeEnginesHud.textContent = `${engines.stt || '?'} → ${engines.llm || '?'} → ${engines.tts || '?'}`;
        }
    } catch (e) {
        if (activeEnginesHud) {
            activeEnginesHud.textContent = 'BACKEND UNREACHABLE';
        }
    }
}

// ── Base64 / ArrayBuffer Utilities ──
function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// ── Interaction Listeners (Tap-To-Talk + Push-To-Talk) ──
let pressStartTime = 0;
let isHoldingPress = false;
let holdTimer = null;

function handleMicDown(e) {
    if (e && e.type === 'touchstart') e.preventDefault();
    if (currentState === 'speaking' || currentState === 'thinking') {
        stopAssistantSpeaking();
        return;
    }

    if (isRecording) {
        // If already recording, clicking immediately stops and sends
        stopRecording();
        return;
    }

    pressStartTime = Date.now();
    isHoldingPress = false;
    clearTimeout(holdTimer);

    // If held for > 350ms, switch to push-to-talk mode
    holdTimer = setTimeout(() => {
        isHoldingPress = true;
    }, 350);

    startRecording();
}

function handleMicUp(e) {
    if (e && e.type === 'touchend') e.preventDefault();
    clearTimeout(holdTimer);

    if (isHoldingPress && isRecording) {
        // Was held down: release stops recording
        stopRecording();
        isHoldingPress = false;
    }
    // If was a quick tap (< 350ms), keep recording until next tap!
}

liveMicBtn.addEventListener('mousedown', handleMicDown);
liveMicBtn.addEventListener('mouseup', handleMicUp);
liveMicBtn.addEventListener('touchstart', handleMicDown, { passive: false });
liveMicBtn.addEventListener('touchend', handleMicUp, { passive: false });

textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendText(textInput.value);
});

textSend.addEventListener('click', () => sendText(textInput.value));

// Expose views globally
window.switchView = switchView;
window.connectWS = connectWS;
window.switchSession = switchSession;

// ── Sidebar Collapsible Interaction ──
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
const chatSidebar = document.getElementById('chat-sidebar');
const sidebarToggleIcon = document.getElementById('sidebar-toggle-icon');
const sidebarToggleText = document.getElementById('sidebar-toggle-text');

if (sidebarToggleBtn && chatSidebar) {
    sidebarToggleBtn.addEventListener('click', () => {
        chatSidebar.classList.toggle('collapsed');
        if (chatSidebar.classList.contains('collapsed')) {
            chatSidebar.style.width = '0px';
            chatSidebar.style.padding = '0px';
            chatSidebar.style.margin = '0px';
            chatSidebar.style.border = 'none';
            if (sidebarToggleIcon) sidebarToggleIcon.textContent = 'menu';
            if (sidebarToggleText) sidebarToggleText.textContent = 'SHOW SHIFTS';
        } else {
            chatSidebar.style.width = '';
            chatSidebar.style.padding = '';
            chatSidebar.style.margin = '';
            chatSidebar.style.border = '';
            if (sidebarToggleIcon) sidebarToggleIcon.textContent = 'menu_open';
            if (sidebarToggleText) sidebarToggleText.textContent = 'HIDE SHIFTS';
        }
    });
}

// ── New Shift Trigger ──
const newShiftBtn = document.getElementById('new-shift-btn');
if (newShiftBtn) {
    newShiftBtn.addEventListener('click', () => {
        const newSessionId = 'web_' + Math.random().toString(36).substring(2, 15);
        switchSession(newSessionId);
    });
}

// ── Session Switcher Logic ──
function switchSession(sessionId) {
    localStorage.setItem('vak_session_id', sessionId);
    if (ws) {
        ws.onclose = null;
        ws.close();
    }
    connectWS();
    fetchSessions();
}

// ── Fetch Past Sessions ──
async function fetchSessions() {
    try {
        const res = await fetch(`${API_URL}/sessions`);
        const data = await res.json();
        renderSessionList(data.sessions || []);
    } catch (e) {
        console.error('Failed to fetch sessions:', e);
    }
}

// ── Render Sidebar Items ──
function renderSessionList(sessions) {
    const sessionList = document.getElementById('session-list');
    if (!sessionList) return;

    if (!sessions || sessions.length === 0) {
        sessionList.innerHTML = '<div class="text-white/30 font-label-mono-xs text-[10px] uppercase text-center mt-8 select-none">// NO PAST SHIFTS</div>';
        return;
    }

    const activeSessionId = localStorage.getItem('vak_session_id');

    sessionList.innerHTML = sessions.map(s => {
        const isActive = s.session_id === activeSessionId;
        const date = new Date(s.last_modified);
        const formattedDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
            date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

        const activeClass = isActive
            ? 'border-electric-blue bg-electric-blue/10 text-white shadow-[0_0_10px_rgba(46,91,255,0.15)]'
            : 'border-white/10 hover:border-white/30 text-white/70 hover:text-white bg-black/40';

        const displayName = s.title || `SHIFT_${s.session_id.substring(0, 6).toUpperCase()}`;

        return `
            <div class="border p-3 cursor-pointer transition-all duration-200 exact-card flex flex-col gap-1.5 ${activeClass}" onclick="switchSession('${s.session_id}')">
                <div class="flex justify-between items-center">
                    <span class="font-label-mono-xs text-[10px] tracking-wider font-semibold truncate max-w-[120px]">${displayName}</span>
                    <span class="font-label-mono-xs text-[8px] text-white/40">${formattedDate}</span>
                </div>
            </div>
        `;
    }).join('');
}

// ── Whoop Cognitive Report Modal Logic ──
const viewReportBtn = document.getElementById('view-report-btn');
const whoopModal = document.getElementById('whoop-modal');
const closeReportBtn = document.getElementById('close-report-btn');

if (viewReportBtn && whoopModal) {
    viewReportBtn.addEventListener('click', async () => {
        whoopModal.classList.add('active');
        await loadAndRenderReport();
    });
}

if (closeReportBtn && whoopModal) {
    closeReportBtn.addEventListener('click', () => {
        whoopModal.classList.remove('active');
    });
}

async function loadAndRenderReport() {
    const sessionId = localStorage.getItem('vak_session_id');
    if (!sessionId) return;

    // Set timestamp
    const tsEl = document.getElementById('whoop-timestamp');
    if (tsEl) tsEl.textContent = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    // Set loading placeholders
    const textIds = [
        'whoop-entropy-title', 'whoop-entropy-subtitle',
        'whoop-granularity-title', 'whoop-granularity-subtitle',
        'whoop-coherence-title', 'whoop-coherence-subtitle',
        'whoop-avoidance-title', 'whoop-avoidance-subtitle',
        'whoop-momentum-core-title', 'whoop-momentum-core-subtitle',
        'rhythm-peak', 'rhythm-consistency', 'rhythm-distraction',
        'weather-mood', 'weather-drift', 'weather-resilience', 'weather-vocab',
        'momentum-ratio', 'momentum-loops', 'momentum-breakthrough',
        'identity-conflict', 'identity-narrative'
    ];
    textIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (id.endsWith('-subtitle')) {
                el.textContent = 'Analyzing dialogue...';
            } else if (id.endsWith('-title')) {
                el.textContent = 'CALIBRATING';
            } else {
                el.textContent = '···';
            }
        }
    });

    const gapTalks = document.getElementById('identity-gap-talks');
    const gapDoes = document.getElementById('identity-gap-does');
    if (gapTalks) gapTalks.textContent = '···';
    if (gapDoes) gapDoes.textContent = '···';

    document.getElementById('whoop-insights').innerHTML = '<div class="whoop-insight-card"><p class="font-body-md text-sm text-white/50 animate-pulse">Synthesizing cognitive patterns from dialogue transcript...</p></div>';

    // Reset progress bars to empty
    ['bar-entropy', 'bar-granularity', 'bar-coherence', 'bar-avoidance', 'bar-momentum-core', 'bar-consistency', 'bar-momentum'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.width = '0%';
    });

    try {
        const res = await fetch(`${API_URL}/sessions/${sessionId}/report`);
        if (!res.ok) {
            let detail = 'No dialogue history available. Start a session in the terminal and speak/type to generate your focus report.';
            try {
                const errData = await res.json();
                detail = errData.detail || detail;
            } catch (err) {}
            throw new Error(detail);
        }
        const report = await res.json();

        // Helper to parse metric title and subtitle
        function parseMetric(val) {
            if (!val) return { title: 'N/A', subtitle: 'Not enough data' };
            const match = val.match(/^([^(]+)\s*(?:\(([^)]+)\))?/);
            if (match) {
                return {
                    title: match[1].trim(),
                    subtitle: match[2] ? match[2].trim() : ''
                };
            }
            return { title: val, subtitle: '' };
        }

        // Helper to map title to rough percentage for visualization
        function metricToPercent(name, title) {
            const lower = title.toLowerCase();
            if (name === 'entropy') {
                if (lower.includes('spacious')) return 85;
                if (lower.includes('balanced')) return 65;
                if (lower.includes('crowded')) return 40;
                if (lower.includes('narrowed')) return 20;
            } else if (name === 'granularity') {
                if (lower.includes('high')) return 90;
                if (lower.includes('moderate')) return 60;
                if (lower.includes('low')) return 30;
            } else if (name === 'coherence') {
                if (lower.includes('agentic')) return 85;
                if (lower.includes('neutral')) return 55;
                if (lower.includes('circumstantial') || lower.includes('drift')) return 30;
            } else if (name === 'avoidance') {
                if (lower.includes('zero') || lower.includes('no')) return 90;
                if (lower.includes('deflective') || lower.includes('loop')) return 45;
                if (lower.includes('active') || lower.includes('avoidance')) return 20;
            } else if (name === 'momentum') {
                if (lower.includes('direct') || lower.includes('flow')) return 90;
                if (lower.includes('hovering') || lower.includes('planning')) return 50;
                if (lower.includes('anxious') || lower.includes('paralysis') || lower.includes('stuck')) return 20;
            }
            return 50;
        }

        // Populate 5 core metrics
        const mEntropy = parseMetric(report.attentional_entropy);
        document.getElementById('whoop-entropy-title').textContent = mEntropy.title;
        document.getElementById('whoop-entropy-subtitle').textContent = mEntropy.subtitle;
        document.getElementById('bar-entropy').style.width = metricToPercent('entropy', mEntropy.title) + '%';

        const mGranularity = parseMetric(report.emotional_granularity);
        document.getElementById('whoop-granularity-title').textContent = mGranularity.title;
        document.getElementById('whoop-granularity-subtitle').textContent = mGranularity.subtitle;
        document.getElementById('bar-granularity').style.width = metricToPercent('granularity', mGranularity.title) + '%';

        const mCoherence = parseMetric(report.narrative_coherence);
        document.getElementById('whoop-coherence-title').textContent = mCoherence.title;
        document.getElementById('whoop-coherence-subtitle').textContent = mCoherence.subtitle;
        document.getElementById('bar-coherence').style.width = metricToPercent('coherence', mCoherence.title) + '%';

        const mAvoidance = parseMetric(report.attentional_avoidance);
        document.getElementById('whoop-avoidance-title').textContent = mAvoidance.title;
        document.getElementById('whoop-avoidance-subtitle').textContent = mAvoidance.subtitle;
        document.getElementById('bar-avoidance').style.width = metricToPercent('avoidance', mAvoidance.title) + '%';

        const mMomentumCore = parseMetric(report.cognitive_momentum);
        document.getElementById('whoop-momentum-core-title').textContent = mMomentumCore.title;
        document.getElementById('whoop-momentum-core-subtitle').textContent = mMomentumCore.subtitle;
        document.getElementById('bar-momentum-core').style.width = metricToPercent('momentum', mMomentumCore.title) + '%';

        // Focus Rhythm
        const rhythm = report.focus_rhythm || {};
        document.getElementById('rhythm-peak').textContent = rhythm.peak_clarity_window || 'Mornings';
        document.getElementById('rhythm-consistency').textContent = rhythm.consistency_score || '8 / 10';
        document.getElementById('rhythm-distraction').textContent = rhythm.distraction_fingerprint || 'None';
        // Animate consistency bar
        const consistencyBar = document.getElementById('bar-consistency');
        if (consistencyBar && rhythm.consistency_score) {
            const score = parseFloat(rhythm.consistency_score) || 7;
            consistencyBar.style.width = (score * 10) + '%';
        }

        // Emotional Weather
        const weather = report.emotional_weather || {};
        document.getElementById('weather-mood').textContent = weather.mood_baseline || 'Centered';
        document.getElementById('weather-drift').textContent = weather.drift_detection || 'Steady';
        document.getElementById('weather-resilience').textContent = weather.resilience_pattern || 'Immediate';
        document.getElementById('weather-vocab').textContent = weather.vocabulary_growth || 'High';

        // Momentum Patterns
        const momentum = report.momentum_patterns || {};
        document.getElementById('momentum-ratio').textContent = momentum.talk_to_action_ratio || 'High';
        document.getElementById('momentum-loops').textContent = momentum.avoidance_loops || 'None';
        document.getElementById('momentum-breakthrough').textContent = momentum.breakthrough_moments || 'Pivoted to action';
        // Animate momentum bar
        const momentumBar = document.getElementById('bar-momentum');
        if (momentumBar && momentum.talk_to_action_ratio) {
            const match = momentum.talk_to_action_ratio.match(/(\d+)\s*out\s*of\s*(\d+)/i);
            if (match) {
                momentumBar.style.width = ((parseInt(match[1]) / parseInt(match[2])) * 100) + '%';
            } else {
                momentumBar.style.width = '50%';
            }
        }

        // Identity Signals — split into dual-card view
        const identity = report.identity_signals || {};
        const gapText = identity.talk_vs_action_gap || 'Well-aligned';
        // Try to split on 'but', 'vs', or comma
        const gapParts = gapText.split(/\s*(?:but|vs\.?|,)\s*/i);
        if (gapTalks) gapTalks.textContent = gapParts[0] || gapText;
        if (gapDoes) gapDoes.textContent = gapParts[1] || 'Aligned';
        // Also set the hidden full-text element for JS access
        const identityGap = document.getElementById('identity-gap');
        if (identityGap) identityGap.textContent = gapText;

        document.getElementById('identity-conflict').textContent = identity.values_in_conflict || 'None';
        document.getElementById('identity-narrative').textContent = identity.narrative_drift || 'Growing stronger';

        // Insights rendering — premium cards
        const insights = report.actionable_insights || [];
        if (insights.length > 0) {
            document.getElementById('whoop-insights').innerHTML = insights.map((ins, i) =>
                `<div class="whoop-insight-card" style="animation: fade-slide-up 0.4s ${0.7 + i * 0.15}s cubic-bezier(0.16, 1, 0.3, 1) forwards; opacity: 0;">
                    <div class="flex items-start gap-3">
                        <span class="font-label-mono-xs text-white/40 text-[9px] mt-0.5 flex-shrink-0">[${String(i + 1).padStart(2, '0')}]</span>
                        <p class="font-body-md text-sm text-white/90 leading-relaxed">${ins}</p>
                    </div>
                </div>`
            ).join('');
        } else {
            document.getElementById('whoop-insights').innerHTML = '<div class="whoop-insight-card"><p class="font-body-md text-sm text-white/90 leading-relaxed">Maintain current execution momentum. You are in flow state.</p></div>';
        }

    } catch (e) {
        console.error('Failed to load focus report:', e);
        document.getElementById('whoop-insights').innerHTML = `
            <div class="whoop-insight-card">
                <p class="font-body-md text-sm text-white/70 leading-relaxed mb-2">// COGNITIVE_DATA_UNAVAILABLE</p>
                <p class="font-body-md text-sm text-white/50 leading-relaxed">${e.message || 'No dialogue history available. Start a session in the terminal and speak/type to generate your focus report.'}</p>
            </div>
        `;
    }
}

function openReport() {
    const whoopModal = document.getElementById('whoop-modal');
    if (whoopModal) {
        whoopModal.classList.add('active');
        loadAndRenderReport();
    }
}
window.openReport = openReport;

// ── Interactive Capability Demo Loaders ──
window.loadDemoDiagram = function() {
    renderActionPlan({
        title: "Microservice Topology",
        objective: "Demonstrate live Mermaid architecture visualizer inside the Action Deck",
        tasks: [
            { id: "t1", text: "Client establishes WebSocket to FastAPI voice gateway", priority: "high", status: "pending" },
            { id: "t2", text: "FastAPI routes inference to Groq / Cerebras", priority: "medium", status: "pending" },
            { id: "t3", text: "Session state and metrics persisted to AWS S3 bucket", priority: "normal", status: "pending" }
        ],
        commands: ["curl -I http://localhost:8000/health"],
        code_snippet: {
            filename: "docker-compose.yml",
            language: "yaml",
            code: "version: '3.8'\nservices:\n  vak-gateway:\n    build: ./backend\n    ports:\n      - '8000:8000'\n    environment:\n      - GROQ_API_KEY=${GROQ_API_KEY}\n      - AWS_S3_BUCKET=vak-session-history"
        },
        diagram: "graph TD\n  Client[Browser Console] -->|WebSocket /ws/voice| Gateway[FastAPI Server]\n  Gateway -->|Streaming LLM| Groq[Groq / Cerebras API]\n  Gateway -->|Speech Synthesis| TTS[Kokoro / Cartesia]\n  Gateway -->|Async Archival| S3[(AWS S3 History)]",
        notes: "Real-time Mermaid diagram rendered client-side on browser CPU at 0 token cost."
    });
    switchTab('action');
};

window.loadDemoApiTest = function() {
    renderActionPlan({
        title: "API Endpoint Inspection",
        objective: "Test backend health status and response latency via in-browser HTTP client",
        tasks: [
            { id: "t1", text: "Click 'TEST' below to execute browser fetch() request", priority: "high", status: "pending" },
            { id: "t2", text: "Inspect status code, latency (ms), and response JSON", priority: "medium", status: "pending" }
        ],
        commands: ["curl http://localhost:8000/health"],
        api_endpoint: {
            method: "GET",
            url: window.location.origin ? `${window.location.origin}/health` : "http://localhost:8000/health",
            body: null
        },
        notes: "In-browser API tester verifies endpoints natively without needing Postman or terminal curl."
    });
    switchTab('action');
};

// Initialize Vault deliverables and WebSocket connection if in Chat view
loadVault();
const activeView = document.querySelector('.view-content.active');
if (activeView && activeView.id === 'view-chat') {
    connectWS();
}


