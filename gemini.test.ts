import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { pcmResponse, speakStream } from "./gemini";

afterEach(() => mock.restore());

// Gemini's server-sent events: \r\n line endings, and network chunks that cut events anywhere.
const sse = (...pieces: string[]) =>
  new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
      controller.close();
    },
  }));
const audioEvent = (bytes: number[]) =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/l16; rate=24000; channels=1", data: Buffer.from(bytes).toString("base64") } }] } }] })}\r\n\r\n`;

test("speakStream yields whole 16-bit samples from Gemini's event stream as they arrive", async () => {
  const first = audioEvent([1, 2, 3]);
  const tts = spyOn(globalThis, "fetch").mockResolvedValueOnce(sse(first.slice(0, 20), first.slice(20), audioEvent([4]), audioEvent([5, 6])));

  const chunks: number[][] = [];
  for await (const chunk of speakStream("key", "hello")) chunks.push([...chunk]);

  expect(String(tts.mock.calls[0][0])).toContain("gemini-3.8-flash-lite-tts:streamGenerateContent?alt=sse");
  expect(chunks).toEqual([[1, 2], [3, 4], [5, 6]]);
});

test("speakStream fails on an error event inside the stream", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(sse(`data: ${JSON.stringify({ error: { code: 500, message: "overloaded" } })}\r\n\r\n`));
  const chunks = speakStream("key", "hello");
  await expect(chunks.next()).rejects.toThrow("overloaded");
});

test("pcmResponse streams the audio as raw PCM", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(sse(audioEvent([1, 2]), audioEvent([3, 4])));
  const res = await pcmResponse(speakStream("key", "hello"), { "x-transcript": "hello" });

  expect(res.headers.get("content-type")).toBe("audio/l16; rate=24000; channels=1");
  expect(res.headers.get("x-transcript")).toBe("hello");
  expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4]);
});

test("pcmResponse fails before sending anything when TTS fails before any audio", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("quota", { status: 429 }));
  await expect(pcmResponse(speakStream("key", "hello"), {})).rejects.toThrow("gemini-3.8-flash-lite-tts 429: quota");
});
