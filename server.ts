import { captureMemory, queryMemoryWorkflow, type CaptureMemoryResult } from "./harness";
import { poll } from "./telegram";
import { z } from "zod";
import { PasskeyAuth, type AuthUser } from "./auth";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

// Blob and Response only take buffers over a plain ArrayBuffer, which is all we ever make.
type Bytes = Buffer<ArrayBuffer>;

async function gemini(model: string, body: object): Promise<any[]> {
  const res = await fetch(`${API}/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${model} ${res.status}: ${await res.text()}`);
  return (await res.json()).candidates?.[0]?.content?.parts ?? [];
}

async function transcribe(audio: ArrayBuffer, mimeType: string): Promise<string> {
  const parts = await gemini("gemini-3.5-transcribe", {
    contents: [{ parts: [{ inlineData: { mimeType, data: Buffer.from(audio).toString("base64") } }] }],
  });
  // The transcript comes in an audioTranscription part, not in text.
  return parts.find((p) => p.audioTranscription)?.audioTranscription.text ?? "";
}

async function speak(text: string): Promise<Bytes> {
  const parts = await gemini("gemini-3.8-flash-tts", {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ["AUDIO"] },
  });
  // Already a complete WAV file, C2PA provenance chunk included.
  return Buffer.from(parts.find((p) => p.inlineData).inlineData.data, "base64");
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

// Audio in, spoken WAV reply out. The web page, and later Telegram and WhatsApp, all go through here.
export async function converse(
  audio: ArrayBuffer,
  mimeType: string,
  options: { sandboxRoot: string; source?: "voice" | "telegram"; capture?: CaptureWorkflow },
): Promise<{ transcript: string; reply: Bytes }> {
  console.log(`converse: ${kb(audio)} of ${mimeType}`);
  const transcript = await timed("transcribe", transcribe(audio, mimeType), JSON.stringify);
  let answer = "I didn't catch that.";
  if (transcript) {
    const result = await timed(
      "harness",
      (options.capture ?? captureMemory)({
        sandboxRoot: options.sandboxRoot,
        transcript,
        source: options.source ?? "voice",
      }),
      (capture: CaptureMemoryResult) => JSON.stringify(capture.createdPaths),
    );
    answer = result.response.trim() || "Captured.";
  }
  const reply = await timed("speak", speak(answer), kb);
  return { transcript, reply };
}

// WhatsApp and Telegram only show OGG/Opus as a voice note.
export function toVoiceNote(wav: Bytes): Promise<Bytes> {
  return timed("voice note", run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "32k", "-ac", "1", "-f", "ogg", "pipe:1"], wav), kb);
}

// Accept: audio/ogg gets a voice note, so a WhatsApp or Telegram round trip can be tried with curl.
export async function talk(req: Request, userId: string, capture: CaptureWorkflow = captureMemory): Promise<Response> {
  const recording = await req.arrayBuffer();
  const mimeType = req.headers.get("content-type")!.split(";")[0];
  // ECHO=1 skips Gemini, so debugging the page costs no tokens.
  if (process.env.ECHO === "1") {
    console.log(`echo: ${kb(recording)} of ${mimeType}`);
    return new Response(recording, { headers: { "content-type": mimeType, "x-transcript": "(echo)" } });
  }
  try {
    const { transcript, reply } = await converse(recording, mimeType, { sandboxRoot: userSandbox(userId), capture });
    const voiceNote = req.headers.get("accept")?.includes("audio/ogg");
    return new Response(voiceNote ? await toVoiceNote(reply) : reply, {
      headers: { "content-type": voiceNote ? "audio/ogg" : "audio/wav", "x-transcript": encodeURIComponent(transcript) },
    });
  } catch (err) {
    console.error("talk failed:", err);
    return new Response(String(err), { status: 502 });
  }
}

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
      "/api/capture/text": { POST: (request) => withUser(request, (user) => captureText(request, user.id)) },
      "/api/query": { POST: (request) => withUser(request, (user) => queryMemory(request, user.id)) },
    },
  });
  console.log(`listening on ${server.url}`);
  if (process.env.TELEGRAM_BOT_TOKEN) poll();
}
