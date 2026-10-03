export function createVoiceController() {
  const mic = document.getElementById("mic");
  const status = document.getElementById("status");
  const spectrum = document.getElementById("spectrum");
  let current;

  // A glowing blob around the mic: 0–6 kHz, where speech lives, mapped onto the rim and mirrored left/right.
  function showSpectrum(stream) {
    const audio = (current = new AudioContext());
    const analyser = audio.createAnalyser();
    audio.createMediaStreamSource(stream).connect(analyser);
    const bins = new Uint8Array(analyser.frequencyBinCount).subarray(0, Math.round(6000 / (audio.sampleRate / analyser.fftSize)));
    const dpr = devicePixelRatio;
    spectrum.width = spectrum.height = spectrum.offsetWidth * dpr;
    const points = 64, g = spectrum.getContext("2d"), c = spectrum.width / 2;
    g.fillStyle = "#da363366";
    g.shadowColor = "#da3633";
    g.shadowBlur = 24 * dpr;
    const base = (mic.offsetWidth / 2 + 4) * dpr, bulge = c - base - g.shadowBlur;
    // Eases toward 1 while listening and back to 0 after, so the blob grows out of and melts back into the button.
    let level = 0, target = 1;
    (function draw() {
      if (audio !== current) return audio.close();
      level += (target - level) * 0.08;
      g.clearRect(0, 0, spectrum.width, spectrum.height);
      if (target === 0 && level < 0.01) return audio.close();
      analyser.getByteFrequencyData(bins);
      g.globalAlpha = level;
      const rim = Array.from({ length: points }, (_, k) => {
        const half = k < points / 2 ? k : points - k;
        const r = base + level * (bins[Math.floor((half * bins.length) / (points / 2 + 1))] / 255) * bulge;
        const a = (k / points) * 2 * Math.PI - Math.PI / 2;
        return [c + r * Math.cos(a), c + r * Math.sin(a)];
      });
      // Curves through the midpoints between rim points keep the edge smooth.
      const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      g.beginPath();
      g.moveTo(...mid(rim[points - 1], rim[0]));
      rim.forEach((p, k) => g.quadraticCurveTo(...p, ...mid(p, rim[(k + 1) % points])));
      g.fill();
      requestAnimationFrame(draw);
    })();
    return () => (target = 0);
  }
  
  // Replies stream in as raw 24 kHz mono 16-bit PCM. Each piece is queued right after the previous one,
  // so playback starts with the first piece instead of after the whole reply.
  let speaker, pendingResponse;
  const playingSources = new Set();
  
  function stopPlayback() {
    for (const source of playingSources) {
      try { source.stop(); } catch {}
    }
    playingSources.clear();
  }
  
  function cancelPendingResponse() {
    if (!pendingResponse) return;
    pendingResponse.controller.abort();
    pendingResponse.socket?.close();
    pendingResponse = null;
    stopPlayback();
  }
  
  async function playStream(body, signal) {
    let at = speaker.currentTime;
    let carry = new Uint8Array(0);
    const playback = [];
    const reader = body.getReader();
    signal.addEventListener("abort", () => reader.cancel(), { once: true });
    for (;;) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const { value, done } = await reader.read();
      if (done) return Promise.all(playback);
      // The network splits the stream anywhere, so half a sample can carry over to the next piece.
      const bytes = new Uint8Array(carry.length + value.length);
      bytes.set(carry);
      bytes.set(value, carry.length);
      const whole = bytes.length - (bytes.length % 2);
      carry = bytes.slice(whole);
      if (!whole) continue;
      const pcm = new DataView(bytes.buffer, 0, whole);
      const buffer = speaker.createBuffer(1, whole / 2, 24000);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i++) channel[i] = pcm.getInt16(i * 2, true) / 32768;
      const source = speaker.createBufferSource();
      source.buffer = buffer;
      source.connect(speaker.destination);
      playingSources.add(source);
      playback.push(new Promise((resolve) => {
        source.onended = () => { playingSources.delete(source); resolve(); };
      }));
      at = Math.max(at, speaker.currentTime + 0.05);
      source.start(at);
      at += buffer.duration;
    }
  }
  
  async function playRecording(blob, signal) {
    const response = await fetch("/api/talk", {
      method: "POST",
      headers: { "content-type": blob.type || "audio/webm", "x-conversation": conversation },
      body: blob,
      signal,
    });
    if (!response.ok) {
      const message = await response.json().catch(() => ({}));
      throw new Error(message.error || `Request failed (${response.status})`);
    }
    const transcript = decodeURIComponent(response.headers.get("x-transcript") || "");
    const audio = await speaker.decodeAudioData(await response.arrayBuffer());
    const source = speaker.createBufferSource();
    source.buffer = audio;
    source.connect(speaker.destination);
    playingSources.add(source);
    const ended = new Promise((resolve) => {
      source.onended = () => { playingSources.delete(source); resolve(); };
    });
    source.start();
    status.textContent = transcript ? `You said: ${transcript}` : "Captured.";
    await ended;
  }
  
  // Audio goes to the server while you talk, so the transcript is ready right after you stop.
  // At 16 kHz the worklet's samples are already in the format Gemini's live transcription wants.
  const captureWorklet = URL.createObjectURL(new Blob([`
    registerProcessor("capture", class extends AudioWorkletProcessor {
      process([input]) {
        if (input[0]) this.port.postMessage(input[0].slice());
        return true;
      }
    });`], { type: "text/javascript" }));
  
  // One conversation per page load, so follow-ups like "say that again?" have context.
  const conversation = crypto.randomUUID();
  
  // Hold to talk, let go to send. Pointer events cover mouse and touch alike.
  let session, held = false;
  mic.addEventListener("pointerdown", (event) => {
    if (held || session) return;
    // The finger may slide off the button; the release still has to land here.
    mic.setPointerCapture(event.pointerId);
    press();
  });
  mic.addEventListener("pointerup", release);
  mic.addEventListener("pointercancel", release);
  mic.addEventListener("contextmenu", (event) => event.preventDefault());
  mic.addEventListener("keydown", (event) => {
    if ((event.key === " " || event.key === "Enter") && !event.repeat && !held && !session) {
      event.preventDefault();
      press();
    }
  });
  mic.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") release();
  });
  
  function press() {
    cancelPendingResponse();
    held = true;
    // Browsers only let audio start from a touch or click, and the reply arrives seconds after this one.
    speaker ??= new AudioContext({ sampleRate: 24000 });
    speaker.resume();
    start();
  }
  
  function release() {
    if (!held) return;
    held = false;
    session?.stop();
  }
  
  async function start() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      held = false;
      status.textContent = "Microphone access is needed to capture a thought.";
      return;
    }
    // A quick tap ends before the microphone is even ready: that's a misfire, not a recording.
    if (!held) {
      stream.getTracks().forEach((t) => t.stop());
      status.textContent = "Hold the circle while you talk.";
      return;
    }
    // The Bun server supports live transcription; the Cloudflare deployment currently uses
    // its recorded-audio endpoint. Avoid a doomed WebSocket upgrade on workers.dev.
    let liveFailed = location.hostname.endsWith(".workers.dev");
    const socket = liveFailed ? null : new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/talk/live?conversation=${conversation}`);
    if (socket) {
      socket.binaryType = "arraybuffer";
      socket.onerror = () => { liveFailed = true; };
    }
  
    // Workers currently use the regular audio endpoint. Keep a browser recording so a failed
    // live upgrade can fall back without asking the user to repeat what they just said.
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    const recording = new Promise((resolve) => {
      recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    });
    recorder.start();
    // Speech captured before the socket opens is queued, so the first words aren't lost.
    const pending = [];
    const send = (data) => (socket?.readyState === WebSocket.OPEN ? socket.send(data) : pending.push(data));
    if (socket) socket.onopen = () => pending.splice(0).forEach((data) => socket.send(data));
  
    const reply = new ReadableStream({
      start(controller) {
        if (!socket) return;
        socket.onmessage = ({ data }) => {
          if (typeof data !== "string") return controller.enqueue(new Uint8Array(data));
          const message = JSON.parse(data);
          mic.className = "";
          mic.setAttribute("aria-label", "Hold to talk");
          status.textContent = message.error ?? "You said: " + message.transcript;
        };
        socket.onclose = () => {
          liveFailed = true;
          controller.close();
        };
      },
    });
  
    const microphone = new AudioContext({ sampleRate: 16000 });
    await microphone.audioWorklet.addModule(captureWorklet);
    const capture = new AudioWorkletNode(microphone, "capture");
    capture.port.onmessage = ({ data }) => {
      const pcm = new Int16Array(data.length);
      for (let i = 0; i < data.length; i++) pcm[i] = Math.max(-1, Math.min(1, data[i])) * 0x7fff;
      send(pcm.buffer);
    };
    microphone.createMediaStreamSource(stream).connect(capture);
    const fadeOut = showSpectrum(stream);
  
    session = {
      async stop() {
        session = null;
        fadeOut();
        microphone.close();
        recorder.stop();
        stream.getTracks().forEach((t) => t.stop());
        mic.className = "thinking";
        mic.setAttribute("aria-label", "Processing recording");
        status.textContent = "Making sense of that…";
        const response = { controller: new AbortController(), socket };
        pendingResponse = response;
        try {
          if (!liveFailed && socket?.readyState === WebSocket.OPEN) {
            send("end");
            await playStream(reply, response.controller.signal);
          } else {
            socket?.close();
            await playRecording(await recording, response.controller.signal);
          }
        } catch (error) {
          if (error.name !== "AbortError") status.textContent = error.message || "Could not process that recording.";
        } finally {
          if (pendingResponse === response) {
            pendingResponse = null;
            mic.className = "";
            mic.setAttribute("aria-label", "Hold to talk");
          }
        }
      },
    };
    mic.className = "listening";
    mic.setAttribute("aria-label", "Recording; let go to send");
    status.textContent = "Listening… let go to send";
    // Let go while the microphone was still starting up: send what there is.
    if (!held) session.stop();
  }
  

  return { cancel: cancelPendingResponse };
}

