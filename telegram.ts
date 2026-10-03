// TEMPORARY: no access control. Anyone who finds the bot can use it, and everything they send lands in user 1's notes.
// Add an allowlist of Telegram user IDs before sharing the bot's username.
import { converse, toVoiceNote } from "./server";
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

async function handle(message: any, dependencies: TelegramDependencies): Promise<void> {
  console.log(`telegram: ${describe(message)}`);
  const chat = message.chat.id;
  const replyTo = { message_id: message.message_id };
  if (!message.voice) {
    await call("sendMessage", { chat_id: chat, text: "Send me a voice note." });
    console.log(`telegram: asked chat ${chat} for a voice note`);
    return;
  }
  // ECHO=1: Telegram resends a file it already has by its ID, so no download, no Gemini, no ffmpeg.
  if (process.env.ECHO === "1") {
    await call("sendVoice", { chat_id: chat, voice: message.voice.file_id, reply_parameters: replyTo });
    console.log(`telegram: echoed the voice note back to chat ${chat}`);
    return;
  }
  try {
    const { reply } = await converse(await download(message.voice.file_id), message.voice.mime_type ?? "audio/ogg", {
      source: "telegram",
      capture: dependencies.capture,
    });
    const form = new FormData();
    form.append("chat_id", String(chat));
    form.append("reply_parameters", JSON.stringify(replyTo));
    form.append("voice", new Blob([await toVoiceNote(reply)], { type: "audio/ogg" }), "reply.ogg");
    await call("sendVoice", form);
    console.log(`telegram: sent a voice note to chat ${chat}`);
  } catch (err) {
    // Details stay in the logs: without access control, a stranger could be reading the chat.
    await call("sendMessage", { chat_id: chat, text: "Something broke, check the logs." });
    throw err;
  }
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
