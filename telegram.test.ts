import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { pollOnce } from "./telegram";

const ok = (result: unknown) => Response.json({ ok: true, result });
const proc = (stdout: string) =>
  ({ stdout: new Response(stdout).body, stderr: new Response("").body, exited: Promise.resolve(0) }) as any;
const voiceUpdate = { update_id: 7, message: { message_id: 3, chat: { id: 42 }, voice: { file_id: "F1", duration: 2, mime_type: "audio/ogg" } } };

// Answers each fetch by the first route whose key is in the URL.
const routes = (table: Record<string, () => Response>) =>
  spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    const key = Object.keys(table).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    return table[key]();
  }) as any);
const callTo = (fetch: ReturnType<typeof routes>, key: string) => fetch.mock.calls.find(([url]) => String(url).includes(key))!;

const sent = (call: unknown[]) => ({ url: call[0] as string, body: JSON.parse((call[1] as RequestInit).body as string) });

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123:abc";
  delete process.env.ECHO; // Bun loads .env into tests too.
});
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
  expect(error.mock.calls[0].join(" ")).toContain("reply to chat 1 failed: Error: telegram sendMessage: Forbidden: bot was blocked by the user");
});

test("a failed getUpdates throws, so poll can back off", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ ok: false, description: "Unauthorized" }));
  await expect(pollOnce(0)).rejects.toThrow("telegram getUpdates: Unauthorized");
});

test("a voice note gets a voice note back, as a reply", async () => {
  const fetch = routes({
    getUpdates: () => ok([voiceUpdate]),
    getFile: () => ok({ file_path: "voice/file_1.oga" }),
    "/file/bot": () => new Response("OGG-IN"),
    "gemini-3.5-transcribe": () => Response.json({ candidates: [{ content: { parts: [{ audioTranscription: { text: "buy milk" } }] } }] }),
    "gemini-3.8-flash-tts": () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: "V0FW" } }] } }] }),
    sendVoice: () => ok({}),
  });
  const spawn = spyOn(Bun, "spawn").mockReturnValueOnce(proc("buy milk")).mockReturnValueOnce(proc("OGG-OUT"));

  expect(await pollOnce(0)).toBe(8);

  expect(callTo(fetch, "/file/bot")[0]).toBe("https://api.telegram.org/file/bot123:abc/voice/file_1.oga");
  expect(sent(callTo(fetch, "gemini-3.5-transcribe")).body.contents[0].parts[0].inlineData).toEqual({
    mimeType: "audio/ogg",
    data: Buffer.from("OGG-IN").toString("base64"),
  });
  expect((spawn.mock.calls[1][0] as string[])[0]).toBe("ffmpeg");
  const form = (callTo(fetch, "sendVoice")[1] as RequestInit).body as FormData;
  expect(form.get("chat_id")).toBe("42");
  expect(JSON.parse(form.get("reply_parameters") as string)).toEqual({ message_id: 3 });
  expect(await (form.get("voice") as Blob).text()).toBe("OGG-OUT");
});

test("ECHO=1 resends the voice note by its file ID without downloading it", async () => {
  process.env.ECHO = "1";
  const fetch = routes({ getUpdates: () => ok([voiceUpdate]), sendVoice: () => ok({}) });
  const spawn = spyOn(Bun, "spawn");

  await pollOnce(0);

  expect(fetch).toHaveBeenCalledTimes(2);
  expect(spawn).not.toHaveBeenCalled();
  expect(sent(callTo(fetch, "sendVoice")).body).toEqual({ chat_id: 42, voice: "F1", reply_parameters: { message_id: 3 } });
});

test("a failure tells the chat to check the logs, and only the logs get the details", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const fetch = routes({
    getUpdates: () => ok([voiceUpdate]),
    getFile: () => Response.json({ ok: false, description: "Bad Request: file is too big" }),
    sendMessage: () => ok({}),
  });

  expect(await pollOnce(0)).toBe(8);

  expect(sent(callTo(fetch, "sendMessage")).body).toEqual({ chat_id: 42, text: "Something broke, check the logs." });
  expect(error.mock.calls[0].join(" ")).toContain("reply to chat 42 failed: Error: telegram getFile: Bad Request: file is too big");
});
