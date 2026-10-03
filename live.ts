// Gemini's live transcription: audio goes in while the user talks, so the transcript is ready
// about 0.4 s after they stop instead of 1.4–1.7 s for uploading the whole recording.
import { toBase64 } from "./gemini";

export const LIVE_URL = "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

type Socket = Pick<WebSocket, "send" | "close" | "readyState" | "addEventListener">;

/** Opens the live socket the Workers way. The key goes in a header: error messages print the URL. */
export async function connectLive(apiKey: string): Promise<WebSocket> {
  const response = await fetch(LIVE_URL, { headers: { Upgrade: "websocket", "x-goog-api-key": apiKey } });
  const socket = (response as Response & { webSocket?: WebSocket & { accept(): void } }).webSocket;
  if (!socket) throw new Error(`live transcription refused: ${response.status} ${await response.text()}`);
  socket.accept();
  return socket;
}

/** Feed 16 kHz mono 16-bit PCM while the user talks; finish() resolves with the transcript. */
export function liveTranscript(socket: Socket) {
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
  let closing = false;
  let queue = Promise.resolve();
  const finish = () => done(pieces.join(" ").trim());

  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : await new Response(event.data as any).text());
    if (message.setupComplete) ready();
    if (message.voiceActivity?.type === "ACTIVITY_START") speaking = true;
    const text = message.serverContent?.inputTranscription?.text;
    if (text) pieces.push(text);
    if (message.serverContent?.generationComplete) {
      speaking = false;
      if (ended) finish();
    }
  });
  socket.addEventListener("close", (event) => {
    if (!closing) failed(new Error(`live transcription closed: ${event.code} ${event.reason}`));
  });
  const sendSetup = () =>
    socket.send(JSON.stringify({
      setup: { model: "models/gemini-3.5-transcribe-live", generationConfig: { responseModalities: ["TEXT"] }, inputAudioTranscription: {} },
    }));
  // A Worker's socket is already open when it arrives; a browser-style one opens later.
  if (socket.readyState === 1) sendSetup();
  else socket.addEventListener("open", sendSetup);

  const close = () => {
    closing = true;
    socket.close();
  };
  return {
    feed(pcm: Uint8Array) {
      const data = toBase64(pcm);
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
      close();
      return text;
    },
    close,
  };
}
