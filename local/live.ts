// Gemini's live transcription: audio goes in while the user talks, so the transcript is ready
// about 0.4 s after they stop instead of 1.4–1.7 s for uploading the whole recording.
const LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

type Socket = Pick<WebSocket, "send" | "close" | "onmessage" | "onclose">;

const connect = (): Socket =>
  new WebSocket(LIVE_URL, {
    // The key goes in a header: error messages print the URL.
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
    proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy,
  } as any);

/** Feed 16 kHz mono 16-bit PCM while the user talks; finish() resolves with the transcript. */
export function liveTranscript(socket: Socket = connect()) {
  let ready!: () => void;
  const setup = new Promise<void>((resolve) => (ready = resolve));
  let done!: (text: string) => void;
  let failed!: (error: Error) => void;
  const transcript = new Promise<string>((resolve, reject) => ((done = resolve), (failed = reject)));
  // A user who disconnects mid-recording never calls finish(); that's not an unhandled failure.
  transcript.catch(() => {});
  const pieces: string[] = [];
  // Speech the model is still transcribing. After silence, or a pause before the tap, nothing more
  // arrives once the stream ends, so finishing must not wait for it.
  let speaking = false;
  let ended = false;
  let queue = Promise.resolve();
  const finish = () => done(pieces.join(" ").trim());

  socket.onmessage = async (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : await new Response(event.data as any).text());
    if (message.setupComplete) ready();
    if (message.voiceActivity?.type === "ACTIVITY_START") speaking = true;
    const text = message.serverContent?.inputTranscription?.text;
    if (text) pieces.push(text);
    if (message.serverContent?.generationComplete) {
      speaking = false;
      if (ended) finish();
    }
  };
  socket.onclose = (event) => failed(new Error(`live transcription closed: ${event.code} ${event.reason}`));
  (socket as WebSocket).onopen = () =>
    socket.send(JSON.stringify({
      setup: { model: "models/gemini-3.5-transcribe-live", generationConfig: { responseModalities: ["TEXT"] }, inputAudioTranscription: {} },
    }));

  return {
    feed(pcm: Uint8Array) {
      const data = Buffer.from(pcm).toString("base64");
      queue = queue.then(() => setup).then(() =>
        socket.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: "audio/pcm;rate=16000" } } })),
      );
    },
    async finish(): Promise<string> {
      await queue.then(() => setup);
      ended = true;
      socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      if (!speaking) finish();
      const text = await transcript;
      socket.onclose = null;
      socket.close();
      return text;
    },
    close() {
      socket.onclose = null;
      socket.close();
    },
  };
}
