import { expect, spyOn, test } from "bun:test";
import { talk } from "./server";

test("talk transcribes the recording and echoes it back", async () => {
  const gemini = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ candidates: [{ content: { parts: [{ text: "" }, { audioTranscription: { text: "hello there" } }] } }] }),
  );
  const res = await talk(
    new Request("http://x/api/talk", { method: "POST", headers: { "content-type": "audio/webm;codecs=opus" }, body: "abc" }),
  );

  const [url, init] = gemini.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("gemini-3.5-transcribe:generateContent");
  expect(JSON.parse(init.body as string).contents[0].parts[0].inlineData).toEqual({ mimeType: "audio/webm", data: "YWJj" });
  expect(decodeURIComponent(res.headers.get("x-transcript")!)).toBe("hello there");
  expect(await res.text()).toBe("abc");
  gemini.mockRestore();
});

test("talk surfaces a Gemini failure", async () => {
  const gemini = spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad key", { status: 403 }));
  const res = await talk(new Request("http://x/api/talk", { method: "POST", headers: { "content-type": "audio/webm" }, body: "abc" }));
  expect(res.status).toBe(502);
  expect(await res.text()).toContain("403: bad key");
  gemini.mockRestore();
});
