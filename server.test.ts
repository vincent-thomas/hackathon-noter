import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { talk } from "./server";

const PCM = Buffer.from([1, 2, 3, 4]);
const heard = (text: string) =>
  Response.json({ candidates: [{ content: { parts: [{ text: "" }, { audioTranscription: { text } }] } }] });
const spoken = () =>
  Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16", data: PCM.toString("base64") } }] } }] });
const post = () =>
  talk(new Request("http://x/api/talk", { method: "POST", headers: { "content-type": "audio/webm;codecs=opus" }, body: "abc" }));
const sent = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

afterEach(() => mock.restore());

test("talk transcribes the recording and speaks the transcript back as WAV", async () => {
  const gemini = spyOn(globalThis, "fetch").mockResolvedValueOnce(heard("hello there")).mockResolvedValueOnce(spoken());
  const res = await post();

  const [stt, tts] = gemini.mock.calls;
  expect(stt[0]).toContain("gemini-3.5-transcribe:generateContent");
  expect(sent(stt).contents[0].parts[0].inlineData).toEqual({ mimeType: "audio/webm", data: "YWJj" });
  expect(tts[0]).toContain("gemini-3.8-flash-tts:generateContent");
  expect(sent(tts)).toEqual({ contents: [{ parts: [{ text: "hello there" }] }], generationConfig: { responseModalities: ["AUDIO"] } });

  expect(res.headers.get("content-type")).toBe("audio/wav");
  expect(decodeURIComponent(res.headers.get("x-transcript")!)).toBe("hello there");
  const body = Buffer.from(await res.arrayBuffer());
  expect(body.toString("ascii", 0, 4) + body.toString("ascii", 8, 16) + body.toString("ascii", 36, 40)).toBe("RIFFWAVEfmt data");
  expect(body.readUInt32LE(4)).toBe(36 + PCM.length);
  expect(body.readUInt32LE(24)).toBe(24000);
  expect(body.readUInt32LE(40)).toBe(PCM.length);
  expect(body.subarray(44)).toEqual(PCM);
});

test("talk says so when it heard nothing", async () => {
  const gemini = spyOn(globalThis, "fetch").mockResolvedValueOnce(heard("")).mockResolvedValueOnce(spoken());
  await post();
  expect(sent(gemini.mock.calls[1]).contents[0].parts[0].text).toBe("I didn't catch that.");
});

test("talk surfaces a Gemini failure", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad key", { status: 403 }));
  const res = await post();
  expect(res.status).toBe(502);
  expect(await res.text()).toContain("gemini-3.5-transcribe 403: bad key");
});
