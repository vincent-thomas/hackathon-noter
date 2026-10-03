import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { captureText, queryMemory, talk } from "./server";
import type { captureMemory, queryMemoryWorkflow } from "./harness";

const WAV = Buffer.from("RIFF....WAVE");
const USER_ID = "test-user";
const heard = (text: string) =>
  Response.json({ candidates: [{ content: { parts: [{ text: "" }, { audioTranscription: { text } }] } }] });
const spoken = () =>
  Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: WAV.toString("base64") } }] } }] });
const remembered = (createdPaths = ["/tasks/hello.md"]) =>
  mock(async () => ({ capture: { path: "/inbox/capture.md", id: "capture" }, createdPaths, accessedPaths: [], response: "Processed." })) as typeof captureMemory;
const post = (capture = remembered()) =>
  talk(new Request("http://x/api/talk", { method: "POST", headers: { "content-type": "audio/webm;codecs=opus" }, body: "abc" }), USER_ID, capture);
const sent = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

// Bun loads .env into tests too, and ECHO=1 there would short-circuit every pipeline test.
beforeEach(() => delete process.env.ECHO);
afterEach(() => mock.restore());

const proc = (stdout: string, code = 0, stderr = "") =>
  ({ stdout: new Response(stdout).body, stderr: new Response(stderr).body, exited: Promise.resolve(code) }) as any;

test("talk transcribes, runs the unified memory interaction, and speaks its response", async () => {
  const gemini = spyOn(globalThis, "fetch").mockResolvedValueOnce(heard("hello there")).mockResolvedValueOnce(spoken());
  const capture = remembered();
  const res = await post(capture);

  expect(capture).toHaveBeenCalledWith({
    sandboxRoot: `${import.meta.dir}/notes/users/${USER_ID}`,
    transcript: "hello there",
    source: "voice",
  });

  const [stt, tts] = gemini.mock.calls;
  expect(stt[0]).toContain("gemini-3.5-transcribe:generateContent");
  expect(sent(stt).contents[0].parts[0].inlineData).toEqual({ mimeType: "audio/webm", data: "YWJj" });
  expect(tts[0]).toContain("gemini-3.8-flash-tts:generateContent");
  expect(sent(tts)).toEqual({
    contents: [{ parts: [{ text: "Processed." }] }],
    generationConfig: { responseModalities: ["AUDIO"] },
  });

  expect(res.headers.get("content-type")).toBe("audio/wav");
  expect(decodeURIComponent(res.headers.get("x-transcript")!)).toBe("hello there");
  expect(Buffer.from(await res.arrayBuffer())).toEqual(WAV);
});

test("Accept: audio/ogg turns the reply into an OGG/Opus voice note", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(heard("hello there")).mockResolvedValueOnce(spoken());
  const spawn = spyOn(Bun, "spawn").mockReturnValueOnce(proc("OggS..."));
  const res = await talk(
    new Request("http://x/api/talk", { method: "POST", headers: { "content-type": "audio/ogg", accept: "audio/ogg" }, body: "abc" }),
    USER_ID,
    remembered(),
  );

  const [cmd, opts] = spawn.mock.calls[0] as [string[], { stdin: Blob }];
  expect(cmd[0]).toBe("ffmpeg");
  expect(cmd.join(" ")).toContain("-c:a libopus");
  expect(cmd.join(" ")).toContain("-f ogg");
  expect(Buffer.from(await opts.stdin.arrayBuffer())).toEqual(WAV);
  expect(res.headers.get("content-type")).toBe("audio/ogg");
  expect(await res.text()).toBe("OggS...");
});

test("talk says so when it heard nothing, without invoking the memory harness", async () => {
  const gemini = spyOn(globalThis, "fetch").mockResolvedValueOnce(heard("")).mockResolvedValueOnce(spoken());
  const capture = remembered();
  await post(capture);
  expect(capture).not.toHaveBeenCalled();
  expect(sent(gemini.mock.calls[1]).contents[0].parts[0].text).toBe("I didn't catch that.");
});

test("talk surfaces a memory harness failure", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(heard("hello there"));
  const capture = mock(async () => { throw new Error("agent failed"); }) as typeof captureMemory;
  const res = await post(capture);
  expect(res.status).toBe(502);
  expect(await res.text()).toContain("agent failed");
});

test("talk surfaces a Gemini failure", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad key", { status: 403 }));
  const res = await post();
  expect(res.status).toBe(502);
  expect(await res.text()).toContain("gemini-3.5-transcribe 403: bad key");
});

test("ECHO=1 plays the recording back without calling Gemini", async () => {
  process.env.ECHO = "1";
  const gemini = spyOn(globalThis, "fetch");
  const res = await post();
  expect(gemini).not.toHaveBeenCalled();
  expect(res.headers.get("content-type")).toBe("audio/webm");
  expect(res.headers.get("x-transcript")).toBe("(echo)");
  expect(await res.text()).toBe("abc");
});

test("POST /api/capture/text runs the programmatic capture workflow", async () => {
  const capture = remembered(["/tasks/ask-erik.md"]);
  const res = await captureText(
    new Request("http://x/api/capture/text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Ask Erik about deployment tomorrow" }),
    }),
    USER_ID,
    capture,
  );

  expect(res.status).toBe(201);
  expect(capture).toHaveBeenCalledWith({
    sandboxRoot: `${import.meta.dir}/notes/users/${USER_ID}`,
    transcript: "Ask Erik about deployment tomorrow",
    source: "text",
  });
  expect((await res.json()).createdPaths).toEqual(["/tasks/ask-erik.md"]);
});

test("POST /api/query returns an answer and separately tracked paths", async () => {
  const query = mock(async () => ({
    answer: "Discuss deployment with Erik.",
    accessedPaths: ["/tasks/ask-erik.md"],
  })) as typeof queryMemoryWorkflow;
  const res = await queryMemory(
    new Request("http://x/api/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What should I discuss with Erik?" }),
    }),
    USER_ID,
    query,
  );

  expect(res.status).toBe(200);
  expect(query).toHaveBeenCalledWith({
    sandboxRoot: `${import.meta.dir}/notes/users/${USER_ID}`,
    question: "What should I discuss with Erik?",
  });
  expect(await res.json()).toEqual({
    answer: "Discuss deployment with Erik.",
    accessedPaths: ["/tasks/ask-erik.md"],
  });
});

test("programmatic endpoints reject invalid JSON input without invoking agents", async () => {
  const capture = remembered();
  const query = mock(async () => ({ answer: "", accessedPaths: [] })) as typeof queryMemoryWorkflow;
  const captureRes = await captureText(new Request("http://x", { method: "POST", body: "{" }), USER_ID, capture);
  const queryRes = await queryMemory(
    new Request("http://x", { method: "POST", body: JSON.stringify({ question: "" }) }),
    USER_ID,
    query,
  );

  expect(captureRes.status).toBe(400);
  expect(queryRes.status).toBe(400);
  expect(capture).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

test("different account IDs resolve to different memory sandboxes", async () => {
  const capture = remembered();
  const request = () => new Request("http://x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Remember this" }),
  });

  await captureText(request(), "user-a", capture);
  await captureText(request(), "user-b", capture);

  expect((capture as any).mock.calls.map(([input]: any[]) => input.sandboxRoot)).toEqual([
    `${import.meta.dir}/notes/users/user-a`,
    `${import.meta.dir}/notes/users/user-b`,
  ]);
});
