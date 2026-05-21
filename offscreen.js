// v1 batch recording (MediaRecorder) keeps working.
let mediaRecorder = null;
let chunks = [];

// v2 streaming state
let streamMedia = null; // MediaStream
let audioCtx = null; // AudioContext
let sourceNode = null; // MediaStreamAudioSourceNode
let processorNode = null; // ScriptProcessorNode
let ws = null; // WebSocket
let isStreaming = false;

const port = chrome.runtime.connect({ name: 'offscreen-recorder' });

port.onMessage.addListener(async (msg) => {
  if (msg.type === 'OFFSCREEN_START') {
    try {
      await startRecording();
      port.postMessage({ type: 'OFFSCREEN_RESULT', ok: true, action: 'start' });
    } catch (e) {
      port.postMessage({ type: 'OFFSCREEN_RESULT', ok: false, action: 'start', error: e?.message || String(e) });
    }
  }

  if (msg.type === 'OFFSCREEN_STOP') {
    try {
      const blob = await stopRecording();
      if (blob.size < 1000) {
        port.postMessage({ type: 'OFFSCREEN_RESULT', ok: false, action: 'stop', error: 'Recording too short (' + blob.size + ' bytes)' });
        return;
      }
      // Transcribe directly from offscreen (full document context, fetch works)
      const stored = await chrome.storage.local.get(['sttUrl', 'sttModel', 'gatewayUrl']);
      const sttUrl = stored.sttUrl || (stored.gatewayUrl ? stored.gatewayUrl.replace(/\/$/, '') + '/v1/audio/transcriptions' : '');
      if (!sttUrl) throw new Error('No STT URL configured');
      const fd = new FormData();
      fd.append('file', blob, 'voice.webm');
      fd.append('model', stored.sttModel || 'large-v3');
      fd.append('language', 'en');
      const res = await fetch(sttUrl, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) throw new Error('Whisper ' + res.status);
      const data = await res.json();
      const text = (data.text || '').trim();
      port.postMessage({ type: 'OFFSCREEN_RESULT', ok: true, action: 'stop', text: text });
    } catch (e) {
      port.postMessage({ type: 'OFFSCREEN_RESULT', ok: false, action: 'stop', error: e?.message || String(e) });
    }
  }

  if (msg.type === 'OFFSCREEN_START_STREAM') {
    try {
      await startStreaming();
      port.postMessage({ type: 'OFFSCREEN_STREAM_RESULT', ok: true, action: 'start_stream' });
    } catch (e) {
      port.postMessage({ type: 'OFFSCREEN_STREAM_RESULT', ok: false, action: 'start_stream', error: e?.message || String(e) });
    }
  }

  if (msg.type === 'OFFSCREEN_STOP_STREAM') {
    try {
      await stopStreaming();
      port.postMessage({ type: 'OFFSCREEN_STREAM_RESULT', ok: true, action: 'stop_stream' });
      port.postMessage({ type: 'OFFSCREEN_STREAM_ENDED' });
    } catch (e) {
      port.postMessage({ type: 'OFFSCREEN_STREAM_RESULT', ok: false, action: 'stop_stream', error: e?.message || String(e) });
      port.postMessage({ type: 'OFFSCREEN_STREAM_ENDED' });
    }
  }
});

// ── v1 batch mode ──
async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? { mimeType: 'audio/webm;codecs=opus' } : {};
  mediaRecorder = new MediaRecorder(stream, options);
  chunks = [];
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.start();
}

function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      reject(new Error('Not recording'));
      return;
    }
    mediaRecorder.onstop = () => {
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      chunks = [];
      mediaRecorder = null;
      resolve(blob);
    };
    mediaRecorder.stop();
  });
}

// ── v2 streaming mode ──

function downsampleFloat32(input, inSampleRate, outSampleRate) {
  if (outSampleRate === inSampleRate) return input;
  if (outSampleRate > inSampleRate) throw new Error('Downsampling rate must be <= input rate');

  const ratio = inSampleRate / outSampleRate;
  const newLength = Math.round(input.length / ratio);
  const result = new Float32Array(newLength);

  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    // Average the samples in range (cheap low-pass)
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
      accum += input[i];
      count++;
    }
    result[offsetResult] = count ? (accum / count) : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = float32[i];
    s = Math.max(-1, Math.min(1, s));
    out[i] = s < 0 ? (s * 0x8000) : (s * 0x7fff);
  }
  return out;
}

async function startStreaming() {
  if (isStreaming) return;

  streamMedia = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });

  // Build ws URL using configured STT URL or gateway fallback
  const stored = await chrome.storage.local.get(['sttUrl', 'sttModel', 'gatewayUrl']);
  const baseUrl = stored.sttUrl || (stored.gatewayUrl ? stored.gatewayUrl.replace(/\/$/, '') : '');
  const wsBase = baseUrl.replace(/^https?:/, 'wss:').replace(/^http:/, 'ws:').replace(/\/v1\/audio\/transcriptions$/, '');
  const model = stored.sttModel || 'deepdml/faster-whisper-large-v3-turbo-ct2';
  const wsUrl = `${wsBase}/v1/realtime?model=${encodeURIComponent(model)}&language=en`;

  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  // Wait for WS to open
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = () => { clearTimeout(t); reject(new Error('WS connect failed')); };
    ws.onclose = (ev) => { clearTimeout(t); reject(new Error(`WS closed (${ev.code} ${ev.reason || 'no reason'})`)); };
  });

  // Configure session FIRST: transcription-only, no response generation.
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      language: 'en',
      turn_detection: { type: 'server_vad', create_response: false, prefix_padding_ms: 300, silence_duration_ms: 1500, threshold: 0.3 },
      input_audio_transcription: { model: 'deepdml/faster-whisper-large-v3-turbo-ct2', language: 'en' },
    }
  }));

  // Wait for session.updated confirmation before sending audio
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 3000); // fallback timeout
    const origOnMessage = ws.onmessage;
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'session.updated') {
          clearTimeout(t);
          resolve();
        }
      } catch {}
      if (origOnMessage) origOnMessage.call(ws, event);
    };
  });

  // NOW setup audio pipeline — session is configured
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaStreamSource(streamMedia);
  processorNode = audioCtx.createScriptProcessor(4096, 1, 1);

  processorNode.onaudioprocess = (e) => {
    if (!isStreaming) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const input = e.inputBuffer.getChannelData(0);
    const down = downsampleFloat32(input, audioCtx.sampleRate, 16000);
    const pcm16 = floatTo16BitPCM(down);

    const bytes = new Uint8Array(pcm16.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const audioB64 = btoa(binary);

    try {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audioB64 }));
    } catch (_) {}
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioCtx.destination);

  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    // Partial deltas
    if (data.type === 'conversation.item.input_audio_transcription.delta') {
      const delta = String(data.delta || '');
      if (delta) port.postMessage({ type: 'OFFSCREEN_PARTIAL', text: delta });
      return;
    }

    // Final transcript
    if (data.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = String(data.transcript || '');
      port.postMessage({ type: 'OFFSCREEN_FINAL', text: transcript });
      return;
    }
  };

  ws.onclose = () => {
    // If we didn't intentionally stop, just mark state.
    if (isStreaming) {
      isStreaming = false;
      port.postMessage({ type: 'OFFSCREEN_STREAM_ENDED' });
    }
  };

  isStreaming = true;
}

async function stopStreaming() {
  if (!isStreaming) return;
  isStreaming = false;

  // Tear down audio graph (stop sending audio)
  try { processorNode && processorNode.disconnect(); } catch {}
  try { sourceNode && sourceNode.disconnect(); } catch {}
  processorNode = null;
  sourceNode = null;

  try {
    if (audioCtx) await audioCtx.close();
  } catch {}
  audioCtx = null;

  // Stop mic tracks
  try { streamMedia?.getTracks?.().forEach(t => t.stop()); } catch {}
  streamMedia = null;

  // Send commit and wait for final transcript before closing WS
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      // Wait up to 10s for the server to send the final transcript
      // The onmessage handler will forward OFFSCREEN_FINAL
      // We just need to not close the WS yet
      await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(), 10000);
        const origOnMessage = ws.onmessage;
        ws.onmessage = (event) => {
          // Forward to original handler
          if (origOnMessage) origOnMessage.call(ws, event);
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'conversation.item.input_audio_transcription.completed') {
              clearTimeout(timeout);
              resolve();
            }
          } catch {}
        };
      });
    }
  } catch (_) {}

  // NOW close WS after receiving transcript (or timeout)
  try {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(1000, 'client stop');
    }
  } catch {}
  ws = null;
}
