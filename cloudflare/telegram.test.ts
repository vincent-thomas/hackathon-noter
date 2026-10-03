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
function linkedChat(harnessAnswer: string, harnessStatus = 200) {
  const sent: Array<{ url: string; body: any }> = [];
  const routes: Array<[string, () => Response]> = [
    ["/getFile", () => Response.json({ ok: true, result: { file_path: "voice/1.oga" } })],
    ["/file/bot", () => new Response("OGG-IN")],
    ["gemini-3.5-transcribe:generateContent", () => Response.json({ candidates: [{ content: { parts: [{ audioTranscription: { text: "Call Sara back tomorrow." } }] } }] })],
    ["api.condense.chat/openai/v1/chat/completions", () => harnessStatus === 200
      ? Response.json({ choices: [{ message: { role: "assistant", content: harnessAnswer } }] })
      : new Response("overloaded", { status: harnessStatus })],
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
    CONDENSE_API_KEY: "c",
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

test("a voice note gets a text reply, with 'typing' meanwhile", async () => {
  const chat = linkedChat("Noted; Sara gets a call tomorrow.");
  await chat.deliver({ voice: { file_id: "F1", mime_type: "audio/ogg" } });

  expect(JSON.parse(chat.calls("sendChatAction")[0].body).action).toBe("typing");
  expect(JSON.parse(chat.calls("sendMessage")[0].body)).toEqual({ chat_id: "42", text: "Noted; Sara gets a call tomorrow.", reply_parameters: { message_id: 7 } });
  expect(chat.calls("sendVoice")).toEqual([]);
});

test("a text message gets a text reply, with 'typing' meanwhile", async () => {
  const chat = linkedChat("Noted; Sara gets a call tomorrow.");
  await chat.deliver({ text: "Call Sara back tomorrow." });

  expect(JSON.parse(chat.calls("sendChatAction")[0].body).action).toBe("typing");
  expect(JSON.parse(chat.calls("sendMessage")[0].body)).toEqual({ chat_id: "42", text: "Noted; Sara gets a call tomorrow.", reply_parameters: { message_id: 7 } });
  expect(chat.calls("sendVoice")).toEqual([]);
});

test("a failure tells the chat to check the logs, and still fails the update so the Worker logs it", async () => {
  spyOn(console, "error").mockImplementation(() => {});
  const chat = linkedChat("", 503);
  await expect(chat.deliver({ text: "Call Sara back tomorrow." })).rejects.toThrow("503");

  expect(JSON.parse(chat.calls("sendMessage")[0].body)).toEqual({ chat_id: "42", text: "Something broke, check the logs.", reply_parameters: { message_id: 7 } });
});
