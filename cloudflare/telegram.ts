import { captureMemory } from "./agent";
import type { Env, User } from "./types";
import { transcribe } from "../gemini";

const LINK_TTL_MS = 10 * 60_000;
const TELEGRAM_API = "https://api.telegram.org";

export async function telegramSettings(env: Env, userId: string) {
  const link = await env.DB.prepare("SELECT chat_id, created_at FROM telegram_links WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(userId).first<{ chat_id: string; created_at: number }>();
  return { linked: Boolean(link), linkedAt: link ? new Date(link.created_at).toISOString() : null };
}

export async function createTelegramLinkCode(env: Env, userId: string) {
  const code = randomCode();
  const expiresAt = Date.now() + LINK_TTL_MS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM telegram_link_codes WHERE expires_at <= ? OR user_id = ?").bind(Date.now(), userId),
    env.DB.prepare("INSERT INTO telegram_link_codes (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await hash(code), userId, expiresAt),
  ]);
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

export async function configureTelegramWebhook(env: Env, origin: string) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) throw new Error("Telegram is not configured");
  const url = `${origin}/api/telegram/webhook`;
  await send(env, "setWebhook", {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"],
  });
  return { configured: true, url };
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return new Response("Telegram is not configured", { status: 503 });
  if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
  const update = await request.json<any>();
  if (update.message) await handleMessage(env, update.message);
  return new Response("ok");
}

async function handleMessage(env: Env, message: any) {
  const chatId = String(message.chat.id);
  const reply = { message_id: message.message_id };
  const link = typeof message.text === "string" ? message.text.match(/^\/link(?:@\w+)?\s+([A-Z0-9]+)\s*$/i) : null;
  if (link) {
    const user = await consumeCode(env, chatId, link[1]);
    await send(env, "sendMessage", {
      chat_id: chatId,
      text: user ? `Linked to ${user.email}. You can send a voice note or text now.` : "That link code is invalid or expired. Generate a new one in notd Settings.",
      reply_parameters: reply,
    });
    return;
  }

  const user = await linkedUser(env, chatId);
  if (!user) {
    await send(env, "sendMessage", {
      chat_id: chatId,
      text: "Link a notd account first. Sign in to notd, open Settings, generate a Telegram code, then send /link CODE here.",
      reply_parameters: reply,
    });
    return;
  }

  const voice = message.voice?.file_id;
  if (typeof message.text !== "string" && !voice) {
    await send(env, "sendMessage", { chat_id: chatId, text: "Send me a voice note or text message.", reply_parameters: reply });
    return;
  }
  console.log(`telegram: ${voice ? `voice note, ${message.voice.duration} s` : `text ${JSON.stringify(message.text)}`} from user ${user.id} in chat ${chatId}`);
  try {
    await answer(env, chatId, user, message, reply, voice);
  } catch (error) {
    // Details stay in the logs; the chat only learns that something broke.
    await send(env, "sendMessage", { chat_id: chatId, text: "Something broke, check the logs.", reply_parameters: reply }).catch(() => {});
    throw error;
  }
}

async function answer(env: Env, chatId: string, user: User, message: any, reply: { message_id: number }, voice: string | undefined) {
  await whileShowing(env, chatId, "typing", async () => {
    const transcript = voice ? await transcribeVoice(env, voice, message.voice.mime_type ?? "audio/ogg") : message.text;
    const response = transcript ? (await captureMemory(env, user.id, transcript, "telegram")).response || "Captured." : "I didn't catch that.";
    return () => send(env, "sendMessage", { chat_id: chatId, text: response, reply_parameters: reply });
  });
}

// Shows `action` while `prepare` works out the reply. Telegram drops it after 5 s, so it's resent;
// it stops before the reply goes out.
async function whileShowing(env: Env, chatId: string, action: "typing", prepare: () => Promise<() => Promise<unknown>>) {
  const show = () => send(env, "sendChatAction", { chat_id: chatId, action }).catch(() => {});
  await show();
  const timer = setInterval(show, 4000);
  let reply: () => Promise<unknown>;
  try {
    reply = await prepare();
  } finally {
    clearInterval(timer);
  }
  const start = performance.now();
  await reply();
  console.log(`telegram: replied to chat ${chatId} in ${Math.round(performance.now() - start)} ms`);
}

async function consumeCode(env: Env, chatId: string, code: string): Promise<User | null> {
  const tokenHash = await hash(code.trim().toUpperCase());
  const row = await env.DB.prepare("SELECT user_id, expires_at FROM telegram_link_codes WHERE token_hash = ?")
    .bind(tokenHash).first<{ user_id: string; expires_at: number }>();
  await env.DB.prepare("DELETE FROM telegram_link_codes WHERE token_hash = ?").bind(tokenHash).run();
  if (!row || row.expires_at <= Date.now()) return null;
  await env.DB.prepare(`INSERT INTO telegram_links (chat_id, user_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, created_at = excluded.created_at`)
    .bind(chatId, row.user_id, Date.now()).run();
  return env.DB.prepare("SELECT id, name, email FROM users WHERE id = ?").bind(row.user_id).first<User>();
}

async function linkedUser(env: Env, chatId: string): Promise<User | null> {
  return env.DB.prepare(`SELECT users.id, users.name, users.email FROM telegram_links
    JOIN users ON users.id = telegram_links.user_id WHERE telegram_links.chat_id = ?`).bind(chatId).first<User>();
}

async function transcribeVoice(env: Env, fileId: string, mimeType: string) {
  const start = performance.now();
  const file = await send(env, "getFile", { file_id: fileId });
  const response = await fetch(`${TELEGRAM_API}/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  if (!response.ok) throw new Error(`Telegram download failed: ${response.status}`);
  const audio = await response.arrayBuffer();
  console.log(`telegram: downloaded ${Math.round(audio.byteLength / 1024)} KB in ${Math.round(performance.now() - start)} ms`);
  return transcribe(env.GEMINI_API_KEY, audio, mimeType);
}

async function send(env: Env, method: string, body: object | FormData): Promise<any> {
  const response = await fetch(
    `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    body instanceof FormData
      ? { method: "POST", body }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const result = await response.json<any>();
  if (!result.ok) throw new Error(`Telegram ${method}: ${result.description}`);
  return result.result;
}

function randomCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => alphabet[byte % alphabet.length]).join("");
}

async function hash(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
