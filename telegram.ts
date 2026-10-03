// TEMPORARY: no access control. Anyone who finds the bot can use it, and everything they send lands in user 1's notes.
// Add an allowlist of Telegram user IDs before sharing the bot's username.

async function call(method: string, body: object = {}): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
  return json.result;
}

function describe(message: any): string {
  const from = message.from ? `@${message.from.username ?? "?"} (user ${message.from.id})` : "unknown sender";
  const what = message.voice ? `voice note, ${message.voice.duration} s` : message.text ? `text ${JSON.stringify(message.text)}` : "something else";
  return `${what} from ${from} in chat ${message.chat.id}`;
}

async function handle(message: any): Promise<void> {
  console.log(`telegram: ${describe(message)}`);
  await call("sendMessage", { chat_id: message.chat.id, text: "Send me a voice note." });
  console.log(`telegram: asked chat ${message.chat.id} for a voice note`);
}

// Waits up to 50 s for new messages. Telegram treats everything below the offset as delivered,
// so a restart mid-batch replays the unfinished messages.
export async function pollOnce(offset: number): Promise<number> {
  const updates = await call("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
  for (const update of updates) {
    offset = update.update_id + 1;
    if (update.message) await handle(update.message).catch((err) => console.error(`telegram: reply to chat ${update.message.chat.id} failed:`, err));
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
