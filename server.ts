import { captureMemory, queryMemoryWorkflow, type CaptureMemoryResult } from "./harness";
import { poll } from "./telegram";
import { z } from "zod";
import { PasskeyAuth, type AuthUser } from "./auth";
import { liveTranscript } from "./live";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

// Blob and Response only take buffers over a plain ArrayBuffer, which is all we ever make.
type Bytes = Buffer<ArrayBuffer>;

async function post(model: string, method: string, body: object): Promise<Response> {
  const res = await fetch(`${API}/${model}:${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${model} ${res.status}: ${await res.text()}`);
  return res;
}

async function gemini(model: string, body: object): Promise<any[]> {
  return (await (await post(model, "generateContent", body)).json()).candidates?.[0]?.content?.parts ?? [];
}

async function transcribe(audio: ArrayBuffer, mimeType: string): Promise<string> {
  const parts = await gemini("gemini-3.5-transcribe", {
    contents: [{ parts: [{ inlineData: { mimeType, data: Buffer.from(audio).toString("base64") } }] }],
  });
  // The transcript comes in an audioTranscription part, not in text.
  return parts.find((p) => p.audioTranscription)?.audioTranscription.text ?? "";
}

// The lite model streams about twice as fast: first audio in ~0.7 s instead of ~1.2 s.
const TTS = "gemini-3.8-flash-lite-tts";
// Without a fixed voice, Gemini picks a different speaker per reply. Algenib is the gravelly one.
const VOICE = "Algenib";
const ttsRequest = (text: string) => ({
  contents: [{ parts: [{ text }] }],
  generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
});

async function speak(text: string): Promise<Bytes> {
  const parts = await gemini(TTS, ttsRequest(text));
  // Already a complete WAV file, C2PA provenance chunk included.
  return Buffer.from(parts.find((p) => p.inlineData).inlineData.data, "base64");
}

// Streamed TTS is bare 24 kHz mono 16-bit PCM, sent as it's generated: the first audio arrives
// in about 1 s instead of the whole reply in 3–4 s. Chunks are cut to whole samples.
export async function* speakStream(text: string): AsyncGenerator<Bytes> {
  const start = performance.now();
  const res = await post(TTS, "streamGenerateContent?alt=sse", ttsRequest(text));
  const decoder = new TextDecoder();
  let events = "";
  let halfSample: Bytes | undefined;
  let bytes = 0;
  for await (const chunk of res.body!) {
    events = (events + decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n");
    for (let end = events.indexOf("\n\n"); end >= 0; end = events.indexOf("\n\n")) {
      const data = events.slice(0, end).split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("");
      events = events.slice(end + 2);
      if (!data) continue;
      const event = JSON.parse(data);
      if (event.error) throw new Error(`${TTS} stream: ${JSON.stringify(event.error)}`);
      for (const part of event.candidates?.[0]?.content?.parts ?? []) {
        if (!part.inlineData) continue;
        let pcm: Bytes = Buffer.from(part.inlineData.data, "base64");
        if (halfSample) pcm = Buffer.concat([halfSample, pcm]);
        const whole = pcm.length - (pcm.length % 2);
        halfSample = whole < pcm.length ? pcm.subarray(whole) : undefined;
        if (!whole) continue;
        if (!bytes) console.log(`speak (stream): first audio after ${Math.round(performance.now() - start)} ms`);
        bytes += whole;
        yield pcm.subarray(0, whole);
      }
    }
  }
  console.log(`speak (stream): ${Math.round(performance.now() - start)} ms → ${kb({ byteLength: bytes })}`);
}

async function run(cmd: string[], input: string | Bytes): Promise<Bytes> {
  const proc = Bun.spawn(cmd, { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${err}`);
  return Buffer.from(out);
}

type CaptureWorkflow = typeof captureMemory;
type QueryWorkflow = typeof queryMemoryWorkflow;
const userSandbox = (userId: string) => `${import.meta.dir}/notes/users/${userId}`;

const TextCaptureRequest = z.object({ text: z.string().trim().min(1) }).strict();
const QueryRequest = z.object({ question: z.string().trim().min(1) }).strict();

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function jsonError(error: unknown, status: number): Response {
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

export async function captureText(request: Request, userId: string, capture: CaptureWorkflow = captureMemory): Promise<Response> {
  let input;
  try {
    input = TextCaptureRequest.parse(await jsonBody(request));
  } catch (error) {
    return jsonError(error, 400);
  }
  try {
    return Response.json(await capture({ sandboxRoot: userSandbox(userId), transcript: input.text, source: "text" }), { status: 201 });
  } catch (error) {
    console.error("text capture failed:", error);
    return jsonError(error, 502);
  }
}

export async function queryMemory(request: Request, userId: string, query: QueryWorkflow = queryMemoryWorkflow): Promise<Response> {
  let input;
  try {
    input = QueryRequest.parse(await jsonBody(request));
  } catch (error) {
    return jsonError(error, 400);
  }
  try {
    return Response.json(await query({ sandboxRoot: userSandbox(userId), question: input.question }));
  } catch (error) {
    console.error("memory query failed:", error);
    return jsonError(error, 502);
  }
}

const kb = (bytes: { byteLength: number }) => `${Math.round(bytes.byteLength / 1024)} KB`;

async function timed<T>(step: string, work: Promise<T>, describe: (result: T) => string): Promise<T> {
  const start = performance.now();
  const result = await work;
  console.log(`${step}: ${Math.round(performance.now() - start)} ms → ${describe(result)}`);
  return result;
}

// Transcript in, the harness's answer out. Every channel, voice or text, goes through here.
export async function respond(
  transcript: string,
  options: { sandboxRoot: string; source: "voice" | "telegram" | "text"; capture?: CaptureWorkflow },
): Promise<string> {
  const start = performance.now();
  const result = await timed(
    "harness",
    (options.capture ?? captureMemory)({
      sandboxRoot: options.sandboxRoot,
      transcript,
      source: options.source,
      // Each tool call costs a model round trip, so these lines show where the harness spends its time.
      onEvent: (event) => {
        if (event.type === "tool_start") {
          console.log(`harness: ${Math.round(performance.now() - start)} ms, ${event.tool} ${JSON.stringify(event.input).slice(0, 120)}`);
        }
      },
    }),
    (capture: CaptureMemoryResult) => JSON.stringify(capture.createdPaths),
  );
  return result.response.trim() || "Captured.";
}

type VoiceOptions = { sandboxRoot: string; source?: "voice" | "telegram"; capture?: CaptureWorkflow };

// Audio in, the transcript and the harness's answer out. Every voice channel goes through here.
async function understand(audio: ArrayBuffer, mimeType: string, options: VoiceOptions): Promise<{ transcript: string; answer: string }> {
  console.log(`converse: ${kb(audio)} of ${mimeType}`);
  const transcript = await timed("transcribe", transcribe(audio, mimeType), JSON.stringify);
  const answer = transcript
    ? await respond(transcript, {
        sandboxRoot: options.sandboxRoot,
        source: options.source ?? "voice",
        capture: options.capture,
      })
    : "I didn't catch that.";
  return { transcript, answer };
}

// The lite TTS model streams a reply faster than it returns it whole: 1.7–2.0 s against ~2.9 s.
const speakWhole = async (text: string): Promise<Bytes> => Buffer.concat(await Array.fromAsync(speakStream(text)));

// Audio in, the spoken reply out as raw PCM.
export async function converse(audio: ArrayBuffer, mimeType: string, options: VoiceOptions): Promise<{ transcript: string; reply: Bytes }> {
  const { transcript, answer } = await understand(audio, mimeType, options);
  return { transcript, reply: await speakWhole(answer) };
}

// Waits for the first chunk, so a TTS failure still gets a clean 502 instead of a silent 200.
async function streamed(audio: AsyncGenerator<Bytes>, headers: Record<string, string>): Promise<Response> {
  const first = await audio.next();
  const body = new ReadableStream<Bytes>({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(first.value);
    },
    async pull(controller) {
      try {
        const next = await audio.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (err) {
        console.error("speak (stream) failed mid-reply:", err);
        controller.error(err);
      }
    },
    async cancel() {
      await audio.return(undefined);
    },
  });
  return new Response(body, { headers: { ...headers, "content-type": "audio/l16; rate=24000; channels=1" } });
}

// WhatsApp and Telegram only show OGG/Opus as a voice note.
// Takes raw 24 kHz mono 16-bit PCM, which has no header, so ffmpeg is told the format.
export function toVoiceNote(pcm: Bytes): Promise<Bytes> {
  return timed(
    "voice note",
    run(["ffmpeg", "-v", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1"], pcm),
    kb,
  );
}

// A real reply takes seconds; this pause lets echo mode show the waiting indicators too.
export const echoDelay = () => Bun.sleep(500 + Math.random() * 500);

// Accept: audio/l16 streams raw PCM as it's generated. Accept: audio/ogg gets a voice note, so a
// WhatsApp or Telegram round trip can be tried with curl. Anything else gets WAV.
export async function talk(req: Request, userId: string, capture: CaptureWorkflow = captureMemory): Promise<Response> {
  const recording = await req.arrayBuffer();
  const mimeType = req.headers.get("content-type")!.split(";")[0];
  // ECHO=1 skips Gemini, so debugging the page costs no tokens.
  if (process.env.ECHO === "1") {
    console.log(`echo: ${kb(recording)} of ${mimeType}`);
    await echoDelay();
    return new Response(recording, { headers: { "content-type": mimeType, "x-transcript": "(echo)" } });
  }
  try {
    const accept = req.headers.get("accept") ?? "";
    const { transcript, answer } = await understand(recording, mimeType, { sandboxRoot: userSandbox(userId), capture });
    const headers = { "x-transcript": encodeURIComponent(transcript) };
    if (accept.includes("audio/l16")) return await streamed(speakStream(answer), headers);
    if (accept.includes("audio/ogg")) {
      return new Response(await toVoiceNote(await speakWhole(answer)), { headers: { ...headers, "content-type": "audio/ogg" } });
    }
    return new Response(await timed("speak", speak(answer), kb), { headers: { ...headers, "content-type": "audio/wav" } });
  } catch (err) {
    console.error("talk failed:", err);
    return new Response(String(err), { status: 502 });
  }
}

type LiveTalk = { userId: string; live?: ReturnType<typeof liveTranscript> };

// The page streams the recording in while the user talks. When it sends "end", the reply comes back on
// the same socket: a JSON message with the transcript, then the spoken reply as raw PCM, then close.
export const liveTalk: Bun.WebSocketHandler<LiveTalk> = {
  open(ws) {
    ws.data.live = liveTranscript();
  },
  async message(ws, message) {
    if (typeof message !== "string") return ws.data.live!.feed(message);
    try {
      const transcript = await timed("transcribe (live)", ws.data.live!.finish(), JSON.stringify);
      const answer = transcript
        ? await respond(transcript, { sandboxRoot: userSandbox(ws.data.userId), source: "voice" })
        : "I didn't catch that.";
      ws.send(JSON.stringify({ transcript }));
      for await (const chunk of speakStream(answer)) ws.send(chunk);
      ws.close();
    } catch (error) {
      console.error("live talk failed:", error);
      ws.send(JSON.stringify({ error: String(error) }));
      ws.close(1011);
    }
  },
  close(ws) {
    ws.data.live?.close();
  },
};

let authInstance: PasskeyAuth | undefined;
function auth(): PasskeyAuth {
  return authInstance ??= new PasskeyAuth({
    databasePath: `${import.meta.dir}/notes/accounts.sqlite`,
    rpID: process.env.PASSKEY_RP_ID ?? "localhost",
    origin: process.env.PASSKEY_ORIGIN ?? "http://localhost:3000",
  });
}

async function withUser(request: Request, handler: (user: AuthUser) => Promise<Response>): Promise<Response> {
  const user = auth().user(request);
  return user ? handler(user) : Response.json({ error: "authentication required" }, { status: 401 });
}

async function authEndpoint(request: Request, action: "register-options" | "register-verify" | "login-options" | "login-verify") {
  try {
    if (action === "register-options") return Response.json(await auth().registrationOptions(await jsonBody(request)));
    if (action === "login-options") return Response.json(await auth().authenticationOptions());
    const result = action === "register-verify"
      ? await auth().verifyRegistration(await jsonBody(request))
      : await auth().verifyAuthentication(await jsonBody(request));
    return Response.json({ user: result.user }, { headers: { "set-cookie": result.cookie } });
  } catch (error) {
    return jsonError(error, 400);
  }
}

if (import.meta.main) {
  const server = Bun.serve({
    port: 3000,
    routes: {
      "/": Bun.file(new URL("index.html", import.meta.url)),
      "/auth-client.js": Bun.file(new URL("node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js", import.meta.url)),
      "/api/auth/options": { POST: async (request) => {
        try {
          return Response.json(await auth().options(await jsonBody(request)));
        } catch (error) {
          return jsonError(error, 400);
        }
      } },
      "/api/auth/register/options": { POST: (request) => authEndpoint(request, "register-options") },
      "/api/auth/register/verify": { POST: (request) => authEndpoint(request, "register-verify") },
      "/api/auth/login/options": { POST: (request) => authEndpoint(request, "login-options") },
      "/api/auth/login/verify": { POST: (request) => authEndpoint(request, "login-verify") },
      "/api/auth/me": { GET: (request) => {
        const user = auth().user(request);
        return user ? Response.json({ user }) : Response.json({ error: "authentication required" }, { status: 401 });
      } },
      "/api/auth/logout": { POST: (request) => Response.json({ ok: true }, { headers: { "set-cookie": auth().logout(request) } }) },
      "/api/talk": { POST: (request) => withUser(request, (user) => talk(request, user.id)) },
      "/api/talk/live": (request, server) => {
        const user = auth().user(request);
        if (!user) return Response.json({ error: "authentication required" }, { status: 401 });
        if (server.upgrade(request, { data: { userId: user.id } })) return;
        return new Response("expected a WebSocket", { status: 400 });
      },
      "/api/capture/text": { POST: (request) => withUser(request, (user) => captureText(request, user.id)) },
      "/api/query": { POST: (request) => withUser(request, (user) => queryMemory(request, user.id)) },
    },
    websocket: liveTalk,
  });
  console.log(`listening on ${server.url}`);
  if (process.env.TELEGRAM_BOT_TOKEN) poll();
}
