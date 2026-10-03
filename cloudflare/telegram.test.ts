import { expect, test } from "bun:test";
import { handleTelegramWebhook } from "./telegram";

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
