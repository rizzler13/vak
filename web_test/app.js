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
// use relative paths to leverage CloudFront's reverse proxy behavior.
const API_URL = window.VAK_API_URL || (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://52.86.214.242:8000'
    : window.location.origin);
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

    ws = new WebSocket(`${WS_URL}/ws/voice?session_id=${sessionId}`);

    ws.onopen = () => {
        if (wsDot) wsDot.className = 'w-2.5 h-2.5 rounded-full bg-status-green pulse-ring relative';
        if (wsStatus) wsStatus.textContent = `connected (session: ${sessionId.substring(0, 8)})`;
        setState('idle');
        fetchHealth();
        fetchSessions();
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'session_init') {
            // Load user insights
            renderInsights(msg.insights);

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
                currentAssistantBubble = null; // reset active response block
                addTranscriptBubble('user', msg.text);
            } else if (msg.role === 'assistant') {
                appendAssistantSentence(msg.text);
            }
        }
        else if (msg.type === 'insights') {
            // Background update received from insights analyzer
            renderInsights(msg.data);
            flashInsightsSnippet();
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
        audioContext = new AudioContext();
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

// ── Mic Recording (Push-to-Talk) ──
async function startRecording() {
    // Automatically suspend background Kanye music on voice interaction
    pauseKanyeMusic();
    stopAssistantSpeaking();

    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
            }
        });

        mediaRecorder = new MediaRecorder(stream, {
            mimeType: 'audio/webm;codecs=opus'
        });

        audioChunks = [];

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
            const blob = new Blob(audioChunks, { type: 'audio/webm' });

            try {
                // Convert WebM to 16kHz WAV mono
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
                stream.getTracks().forEach(t => t.stop());
            }
        };

        mediaRecorder.start();
        isRecording = true;
        setState('listening');
    } catch (e) {
        console.error('Mic error:', e);
        voiceStateText.textContent = 'MIC ACCESS DENIED';
        voiceStateText.className = 'font-label-mono-sm text-label-mono-sm uppercase text-red-500 tracking-widest select-none';
    }
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;
    }
}

// ── WAV Conversion ──
async function convertToWav(blob) {
    if (!audioContext) audioContext = new AudioContext();

    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Resample to 16kHz mono
    const offlineCtx = new OfflineAudioContext(1, audioBuffer.duration * 16000, 16000);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start();

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
function sendText(text) {
    if (!text.trim() || !ws || ws.readyState !== WebSocket.OPEN) return;

    pauseKanyeMusic();
    stopAssistantSpeaking();

    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    currentAssistantBubble = null; // reset active response block
    setState('thinking');

    ws.send(JSON.stringify({
        type: 'text',
        text: text.trim()
    }));

    textInput.value = '';
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

// ── Interaction Listeners (Push-To-Talk) ──
liveMicBtn.addEventListener('mousedown', () => {
    if (currentState === 'speaking' || currentState === 'thinking') return;
    startRecording();
});

liveMicBtn.addEventListener('mouseup', () => {
    if (isRecording) stopRecording();
});

liveMicBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (currentState === 'speaking' || currentState === 'thinking') return;
    startRecording();
});

liveMicBtn.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (isRecording) stopRecording();
});

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

// Initialize connection if in Chat view already, otherwise connect when switched
const activeView = document.querySelector('.view-content.active');
if (activeView && activeView.id === 'view-chat') {
    connectWS();
}

