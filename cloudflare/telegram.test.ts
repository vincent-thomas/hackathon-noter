import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { configureTelegramWebhook, handleTelegramWebhook } from "./telegram";
import { Bucket } from "./test-bucket";

afterEach(() => mock.restore());

test("Telegram webhook requires its configured secret", async () => {
  const env = { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_WEBHOOK_SECRET: "secret" } as any;
  const rejected = await handleTelegramWebhook(new Request("https://noter.example/api/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
    body: "{}",
  }), env);
  expect(rejected.status).toBe(401);
});

test("Telegram webhook refuses to run without production credentials", async () => {
  const response = await handleTelegramWebhook(new Request("https://noter.example/api/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }), {} as any);
  expect(response.status).toBe(503);
});

test("configures Telegram to call the production webhook with secret verification", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, result: true }));
  const env = { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "webhook-secret" } as any;

  await expect(configureTelegramWebhook(env, "https://noter.example")).resolves.toEqual({
    configured: true,
    url: "https://noter.example/api/telegram/webhook",
  });
  const request = fetch.mock.calls[0][1] as RequestInit;
  expect(fetch.mock.calls[0][0]).toBe("https://api.telegram.org/botbot-token/setWebhook");
  expect(JSON.parse(request.body as string)).toEqual({
    url: "https://noter.example/api/telegram/webhook",
    secret_token: "webhook-secret",
    allowed_updates: ["message"],
  });
});

// A linked user, empty memory, and fake Telegram and Gemini answering by URL.
function linkedChat(harnessAnswer: string) {
  const sent: Array<{ url: string; body: any }> = [];
  const pcm = new Uint8Array(4800);
  const routes: Array<[string, () => Response]> = [
    ["/getFile", () => Response.json({ ok: true, result: { file_path: "voice/1.oga" } })],
    ["/file/bot", () => new Response("OGG-IN")],
    ["gemini-3.5-transcribe:generateContent", () => Response.json({ candidates: [{ content: { parts: [{ audioTranscription: { text: "Call Sara back tomorrow." } }] } }] })],
    ["gemini-3.5-flash-lite:generateContent", () => Response.json({ candidates: [{ content: { role: "model", parts: [{ text: harnessAnswer }] } }] })],
    ["streamGenerateContent", () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from(pcm).toString("base64") } }] } }] })}\r\n\r\n`)],
    ["api.telegram.org", () => Response.json({ ok: true, result: {} })],
  ];
  spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: init?.body });
    return routes.find(([key]) => String(url).includes(key))![1]();
  }) as any);
  const env = {
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_WEBHOOK_SECRET: "s",
    GEMINI_API_KEY: "k",
    MEMORY: new Bucket(),
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "user-1", name: "Sara", email: "s@example.com" }) }) }) },
  } as any;
  const deliver = (message: object) =>
    handleTelegramWebhook(new Request("https://noter.example/api/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s" },
      body: JSON.stringify({ message: { message_id: 7, chat: { id: 42 }, ...message } }),
    }), env);
  const calls = (method: string) => sent.filter(({ url }) => url.endsWith(`/${method}`));
  return { deliver, calls };
}

test("a voice note gets an MP3 voice note back, with 'recording voice' meanwhile", async () => {
  const chat = linkedChat("Noted; Sara gets a call tomorrow.");
  await chat.deliver({ voice: { file_id: "F1", mime_type: "audio/ogg" } });

  expect(JSON.parse(chat.calls("sendChatAction")[0].body).action).toBe("record_voice");
  const form = chat.calls("sendVoice")[0].body as FormData;
  expect(form.get("chat_id")).toBe("42");
  expect(JSON.parse(form.get("reply_parameters") as string)).toEqual({ message_id: 7 });
  const voice = form.get("voice") as Blob;
  expect(voice.type).toBe("audio/mpeg");
  const head = new Uint8Array(await voice.arrayBuffer()).subarray(0, 2);
  // An MP3 frame starts with 11 set bits.
  expect(head[0] === 0xff && (head[1] & 0xe0) === 0xe0).toBe(true);
  expect(chat.calls("sendMessage")).toEqual([]);
});

test("a text message gets a text reply, with 'typing' meanwhile", async () => {
  const chat = linkedChat("Noted; Sara gets a call tomorrow.");
  await chat.deliver({ text: "Call Sara back tomorrow." });

  expect(JSON.parse(chat.calls("sendChatAction")[0].body).action).toBe("typing");
  expect(JSON.parse(chat.calls("sendMessage")[0].body)).toEqual({ chat_id: "42", text: "Noted; Sara gets a call tomorrow.", reply_parameters: { message_id: 7 } });
  expect(chat.calls("sendVoice")).toEqual([]);
});
