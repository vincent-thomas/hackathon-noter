// TEMPORARY: no access control. Anyone who finds the bot can use it, and everything they send lands in user 1's notes.
// Add an allowlist of Telegram user IDs before sharing the bot's username.
import { converse, echoDelay, respond, toVoiceNote } from "./server";
import type { captureMemory } from "./harness";

type TelegramDependencies = { capture?: typeof captureMemory };

const api = (path = "") => `https://api.telegram.org/${path}bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function call(method: string, body: object | FormData = {}): Promise<any> {
  const res = await fetch(
    `${api()}/${method}`,
    body instanceof FormData
      ? { method: "POST", body }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const json: any = await res.json();
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
  return json.result;
}

function describe(message: any): string {
  const from = message.from ? `@${message.from.username ?? "?"} (user ${message.from.id})` : "unknown sender";
  const what = message.voice ? `voice note, ${message.voice.duration} s` : message.text ? `text ${JSON.stringify(message.text)}` : "something else";
  return `${what} from ${from} in chat ${message.chat.id}`;
}

async function download(fileId: string): Promise<ArrayBuffer> {
  const { file_path } = await call("getFile", { file_id: fileId });
  const res = await fetch(`${api("file/")}/${file_path}`);
  if (!res.ok) throw new Error(`telegram download ${res.status}`);
  return res.arrayBuffer();
}

/** Runs `task` every `ms` until the returned function is called. Failures go to `onError`. */
export function repeat(task: () => Promise<unknown>, ms: number, onError: (err: unknown) => void): () => void {
  const timer = setInterval(() => task().catch(onError), ms);
  return () => clearInterval(timer);
}

// Telegram drops a chat action after 5 s, so it's resent until the reply is out.
// Only the first one is awaited: if that fails, the reply fails too.
async function showAction(chat: number, action: "record_voice" | "typing"): Promise<() => void> {
  const show = () => call("sendChatAction", { chat_id: chat, action });
  await show();
  console.log(`telegram: showing ${action} in chat ${chat}`);
  return repeat(show, 4000, (err) => console.error(`telegram: chat action in chat ${chat} failed:`, err));
}

// Shows `action` while `prepare` works out the reply, stops it, then sends the reply.
async function sendAfter(chat: number, action: "record_voice" | "typing", prepare: () => Promise<() => Promise<unknown>>) {
  let stop = () => {};
  try {
    stop = await showAction(chat, action);
    const send = await prepare();
    stop();
    await send();
  } catch (err) {
    // Details stay in the logs: without access control, a stranger could be reading the chat.
    stop();
    await call("sendMessage", { chat_id: chat, text: "Something broke, check the logs." });
    throw err;
  }
}

async function handle(message: any, dependencies: TelegramDependencies): Promise<void> {
  console.log(`telegram: ${describe(message)}`);
  const chat = message.chat.id;
  const replyTo = { message_id: message.message_id };
  // ECHO=1 skips Gemini: text comes back as is, and Telegram resends a voice note by its file ID.
  const echo = process.env.ECHO === "1";

  if (message.text) {
    await sendAfter(chat, "typing", async () => {
      const text = echo
        ? (await echoDelay(), message.text)
        : await respond(message.text, { source: "telegram", capture: dependencies.capture });
      return () => call("sendMessage", { chat_id: chat, text, reply_parameters: replyTo });
    });
    console.log(`telegram: answered chat ${chat} in text`);
    return;
  }
  if (!message.voice) {
    await call("sendMessage", { chat_id: chat, text: "Send me a voice note or a text message." });
    console.log(`telegram: asked chat ${chat} for a voice note or text`);
    return;
  }
  await sendAfter(chat, "record_voice", async () => {
    if (echo) {
      await echoDelay();
      return () => call("sendVoice", { chat_id: chat, voice: message.voice.file_id, reply_parameters: replyTo });
    }
    const { reply } = await converse(await download(message.voice.file_id), message.voice.mime_type ?? "audio/ogg", {
      source: "telegram",
      capture: dependencies.capture,
    });
    const form = new FormData();
    form.append("chat_id", String(chat));
    form.append("reply_parameters", JSON.stringify(replyTo));
    form.append("voice", new Blob([await toVoiceNote(reply)], { type: "audio/ogg" }), "reply.ogg");
    return () => call("sendVoice", form);
  });
  console.log(`telegram: ${echo ? "echoed the voice note back" : "sent a voice note"} to chat ${chat}`);
}

// Waits up to 50 s for new messages. Telegram treats everything below the offset as delivered,
// so a restart mid-batch replays the unfinished messages.
export async function pollOnce(offset: number, dependencies: TelegramDependencies = {}): Promise<number> {
  const updates = await call("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
  for (const update of updates) {
    offset = update.update_id + 1;
    if (update.message) await handle(update.message, dependencies).catch((err) => console.error(`telegram: reply to chat ${update.message.chat.id} failed:`, err));
  }
  return offset;
}

export async function poll(): Promise<void> {
  try {
    const me = await call("getMe");
    console.log(`telegram: polling as @${me.username}`);
  } catch (err) {
    console.error("telegram: bot disabled, check TELEGRAM_BOT_TOKEN:", err);
    return;
  }
  let offset = 0;
  for (;;) {
    try {
      offset = await pollOnce(offset);
    } catch (err) {
      console.error("telegram: polling failed, retrying in 5 s:", err);
      await Bun.sleep(5000);
    }
  }
}
