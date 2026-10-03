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

async function handle(message: any): Promise<void> {
  await call("sendMessage", { chat_id: message.chat.id, text: "Send me a voice note." });
}

// Waits up to 50 s for new messages. Telegram treats everything below the offset as delivered,
// so a restart mid-batch replays the unfinished messages.
export async function pollOnce(offset: number): Promise<number> {
  const updates = await call("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
  for (const update of updates) {
    offset = update.update_id + 1;
    if (update.message) await handle(update.message).catch((err) => console.error(err));
  }
  return offset;
}

export async function poll(): Promise<never> {
  let offset = 0;
  for (;;) {
    try {
      offset = await pollOnce(offset);
    } catch (err) {
      console.error(err);
      await Bun.sleep(5000);
    }
  }
}
