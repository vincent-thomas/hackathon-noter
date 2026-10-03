import { z } from "zod";
import { authOptions, currentUser, logout, verifyAuthentication, verifyRegistration } from "./cloudflare/auth";
import { captureMemory, queryMemory } from "./cloudflare/agent";
import { briefingSettings, runMorningBriefings, updateBriefingSettings } from "./cloudflare/briefing";
import { configureTelegramWebhook, createTelegramLinkCode, handleTelegramWebhook, telegramSettings } from "./cloudflare/telegram";
import type { Env, User } from "./cloudflare/types";
import { pcmResponse, speak, speakStream, transcribe } from "./gemini";
import { connectLive, liveTranscript } from "./live";

const TextInput = z.object({ text: z.string().trim().min(1).max(100_000) }).strict();
const QueryInput = z.object({ question: z.string().trim().min(1).max(20_000) }).strict();

function jsonError(error: unknown, status = 400) {
  if (status >= 500) console.error(`request failed with ${status}:`, error);
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

async function body(request: Request) {
  try { return await request.json(); }
  catch { throw new Error("request body must be valid JSON"); }
}

async function withUser(env: Env, request: Request, work: (user: User) => Promise<Response>) {
  const user = await currentUser(env, request);
  return user ? work(user) : jsonError("authentication required", 401);
}

async function api(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const authEnv = { ...env, PASSKEY_RP_ID: url.hostname, PASSKEY_ORIGIN: url.origin };
  if (request.method === "POST" && pathname === "/api/telegram/webhook") {
    try { return await handleTelegramWebhook(request, env); }
    catch (error) { console.error("Telegram webhook failed:", error); return new Response("ok"); }
  }
  if (request.method === "POST" && pathname === "/api/auth/options") {
    try { return Response.json(await authOptions(authEnv, await body(request))); } catch (error) { return jsonError(error); }
  }
  if (request.method === "POST" && pathname === "/api/auth/register/verify") {
    try {
      const result = await verifyRegistration(authEnv, await body(request));
      return Response.json({ user: result.user }, { headers: { "set-cookie": result.cookie } });
    } catch (error) { return jsonError(error); }
  }
  if (request.method === "POST" && pathname === "/api/auth/login/verify") {
    try {
      const result = await verifyAuthentication(authEnv, await body(request));
      return Response.json({ user: result.user }, { headers: { "set-cookie": result.cookie } });
    } catch (error) { return jsonError(error); }
  }
  if (request.method === "GET" && pathname === "/api/auth/me") {
    const user = await currentUser(env, request);
    return user ? Response.json({ user }) : jsonError("authentication required", 401);
  }
  if (request.method === "POST" && pathname === "/api/auth/logout") {
    return Response.json({ ok: true }, { headers: { "set-cookie": await logout(env, request) } });
  }
  if (request.method === "GET" && pathname === "/api/settings/briefing") return withUser(env, request, async (user) => {
    try { return Response.json(await briefingSettings(env, user.id)); }
    catch (error) { return jsonError(error); }
  });
  if (request.method === "POST" && pathname === "/api/settings/briefing") return withUser(env, request, async (user) => {
    try { return Response.json(await updateBriefingSettings(env, user.id, await body(request))); }
    catch (error) { return jsonError(error); }
  });
  if (request.method === "GET" && pathname === "/api/settings/telegram") return withUser(env, request, async (user) => {
    try { return Response.json(await telegramSettings(env, user.id)); }
    catch (error) { return jsonError(error); }
  });
  if (request.method === "POST" && pathname === "/api/settings/telegram/link-code") return withUser(env, request, async (user) => {
    try {
      await configureTelegramWebhook(env, url.origin);
      return Response.json(await createTelegramLinkCode(env, user.id));
    }
    catch (error) { return jsonError(error); }
  });
  if (request.method === "POST" && pathname === "/api/capture/text") return withUser(env, request, async (user) => {
    try {
      const input = TextInput.parse(await body(request));
      return Response.json(await captureMemory(env, user.id, input.text, "text"), { status: 201 });
    } catch (error) { return jsonError(error, 502); }
  });
  if (request.method === "POST" && pathname === "/api/query") return withUser(env, request, async (user) => {
    try {
      const input = QueryInput.parse(await body(request));
      return Response.json(await queryMemory(env, user.id, input.question));
    } catch (error) { return jsonError(error, 502); }
  });
  // The page streams the recording in while the user talks. When it sends "end", the reply comes back
  // on the same socket: a JSON message with the transcript, then the spoken reply as raw PCM, then close.
  if (request.method === "GET" && pathname === "/api/talk/live") return withUser(env, request, async (user) => {
    if (request.headers.get("upgrade") !== "websocket") return jsonError("expected a WebSocket", 400);
    const live = liveTranscript(await connectLive(env.GEMINI_API_KEY));
    const [client, socket] = Object.values(new WebSocketPair());
    socket.accept();
    // Binary messages may arrive as a Blob, which only reads asynchronously; the chain keeps the audio in order.
    let audio = Promise.resolve();
    socket.addEventListener("message", async ({ data }) => {
      if (typeof data !== "string") {
        audio = audio.then(async () => live.feed(new Uint8Array(await new Response(data).arrayBuffer())));
        return;
      }
      try {
        await audio;
        const tap = performance.now();
        const transcript = await live.finish();
        console.log(`transcribe (live): ${Math.round(performance.now() - tap)} ms after the tap → ${JSON.stringify(transcript)}`);
        const conversation = url.searchParams.get("conversation") ?? undefined;
        const answer = transcript ? (await captureMemory(env, user.id, transcript, "voice", conversation)).response : "I didn't catch that.";
        socket.send(JSON.stringify({ transcript }));
        for await (const chunk of speakStream(env.GEMINI_API_KEY, answer)) socket.send(chunk);
        socket.close(1000);
      } catch (error) {
        console.error("live talk failed:", error);
        socket.send(JSON.stringify({ error: String(error) }));
        socket.close(1011);
      }
    });
    socket.addEventListener("close", () => live.close());
    return new Response(null, { status: 101, webSocket: client });
  });

  if (request.method === "POST" && pathname === "/api/talk") return withUser(env, request, async (user) => {
    try {
      const audio = await request.arrayBuffer();
      if (audio.byteLength > 20 * 1024 * 1024) return jsonError("recording is too large", 413);
      const mimeType = request.headers.get("content-type")?.split(";")[0] || "audio/webm";
      const transcript = await transcribe(env.GEMINI_API_KEY, audio, mimeType);
      const conversation = request.headers.get("x-conversation") ?? undefined;
      const answer = transcript ? (await captureMemory(env, user.id, transcript, "voice", conversation)).response : "I didn't catch that.";
      const headers = { "x-transcript": encodeURIComponent(transcript) };
      // Accept: audio/l16 streams raw PCM as it's generated; anything else gets a complete WAV.
      if (request.headers.get("accept")?.includes("audio/l16")) return await pcmResponse(speakStream(env.GEMINI_API_KEY, answer), headers);
      return new Response(await speak(env.GEMINI_API_KEY, answer), { headers: { ...headers, "content-type": "audio/wav" } });
    } catch (error) { return jsonError(error, 502); }
  });
  return pathname.startsWith("/api/") ? jsonError("not found", 404) : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await api(request, env) ?? env.ASSETS.fetch(request);
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const result = await runMorningBriefings(env, new Date(controller.scheduledTime));
    console.log("morning briefing run:", result);
  },
} satisfies ExportedHandler<Env>;
