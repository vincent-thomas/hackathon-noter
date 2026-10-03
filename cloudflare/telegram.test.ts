import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { configureTelegramWebhook, handleTelegramWebhook } from "./telegram";

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
