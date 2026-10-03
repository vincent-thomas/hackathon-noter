import { z } from "zod";
import { authOptions, currentUser, logout, verifyAuthentication, verifyRegistration } from "./cloudflare/auth";
import { captureMemory, queryMemory } from "./cloudflare/agent";
import { briefingSettings, runMorningBriefings, updateBriefingSettings } from "./cloudflare/briefing";
import { configureTelegramWebhook, createTelegramLinkCode, handleTelegramWebhook, telegramSettings } from "./cloudflare/telegram";
import type { Env, User } from "./cloudflare/types";

const TextInput = z.object({ text: z.string().trim().min(1).max(100_000) }).strict();
const QueryInput = z.object({ question: z.string().trim().min(1).max(20_000) }).strict();

function jsonError(error: unknown, status = 400) {
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

async function body(request: Request) {
  try { return await request.json(); }
  catch { throw new Error("request body must be valid JSON"); }
}

async function gemini(env: Env, model: string, payload: object): Promise<any[]> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${model} ${response.status}: ${await response.text()}`);
  return (await response.json<any>()).candidates?.[0]?.content?.parts ?? [];
}

async function transcribe(env: Env, audio: ArrayBuffer, mimeType: string) {
  const parts = await gemini(env, "gemini-3.5-transcribe", {
    contents: [{ parts: [{ inlineData: { mimeType, data: arrayBufferToBase64(audio) } }] }],
  });
  return parts.find((part) => part.audioTranscription)?.audioTranscription.text ?? "";
}

async function speak(env: Env, text: string) {
  const parts = await gemini(env, "gemini-3.8-flash-lite-tts", {
    contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ["AUDIO"] },
  });
  const encoded = parts.find((part) => part.inlineData)?.inlineData.data;
  if (!encoded) throw new Error("Gemini returned no speech audio");
  return base64ToBytes(encoded);
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function base64ToBytes(encoded: string) {
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
  if (request.method === "POST" && pathname === "/api/talk") return withUser(env, request, async (user) => {
    try {
      const audio = await request.arrayBuffer();
      if (audio.byteLength > 20 * 1024 * 1024) return jsonError("recording is too large", 413);
      const mimeType = request.headers.get("content-type")?.split(";")[0] || "audio/webm";
      const transcript = await transcribe(env, audio, mimeType);
      const answer = transcript ? (await captureMemory(env, user.id, transcript, "voice")).response : "I didn't catch that.";
      return new Response(await speak(env, answer), { headers: { "content-type": "audio/wav", "x-transcript": encodeURIComponent(transcript) } });
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
