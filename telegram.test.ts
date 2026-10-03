import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { pollOnce } from "./telegram";

const ok = (result: unknown) => Response.json({ ok: true, result });
const sent = (call: unknown[]) => ({ url: call[0] as string, body: JSON.parse((call[1] as RequestInit).body as string) });

beforeEach(() => (process.env.TELEGRAM_BOT_TOKEN = "123:abc"));
afterEach(() => {
  mock.restore();
  delete process.env.TELEGRAM_BOT_TOKEN;
});

test("pollOnce long-polls for messages and asks for a voice note", async () => {
  const telegram = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(ok([{ update_id: 7, message: { chat: { id: 42 }, text: "hi" } }]))
    .mockResolvedValueOnce(ok({}));

  expect(await pollOnce(5)).toBe(8);

  const [getUpdates, sendMessage] = telegram.mock.calls.map(sent);
  expect(getUpdates.url).toBe("https://api.telegram.org/bot123:abc/getUpdates");
  expect(getUpdates.body).toEqual({ offset: 5, timeout: 50, allowed_updates: ["message"] });
  expect(sendMessage.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
  expect(sendMessage.body).toEqual({ chat_id: 42, text: "Send me a voice note." });
});

test("pollOnce keeps the offset when there is nothing new", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(ok([]));
  expect(await pollOnce(5)).toBe(5);
});

test("a failed reply doesn't stop the batch", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const telegram = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(ok([
      { update_id: 7, message: { chat: { id: 1 } } },
      { update_id: 8, message: { chat: { id: 2 } } },
    ]))
    .mockResolvedValueOnce(Response.json({ ok: false, description: "Forbidden: bot was blocked by the user" }))
    .mockResolvedValueOnce(ok({}));

  expect(await pollOnce(0)).toBe(9);
  expect(sent(telegram.mock.calls[2]).body.chat_id).toBe(2);
  expect(String(error.mock.calls[0][0])).toContain("telegram sendMessage: Forbidden: bot was blocked by the user");
});

test("a failed getUpdates throws, so poll can back off", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ ok: false, description: "Unauthorized" }));
  await expect(pollOnce(0)).rejects.toThrow("telegram getUpdates: Unauthorized");
});
