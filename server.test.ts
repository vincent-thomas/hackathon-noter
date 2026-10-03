import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { talk } from "./server";

const WAV = Buffer.from("RIFF....WAVE");
const heard = (text: string) =>
  Response.json({ candidates: [{ content: { parts: [{ text: "" }, { audioTranscription: { text } }] } }] });
const spoken = () =>
  Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: WAV.toString("base64") } }] } }] });
const post = () =>
  talk(new Request("http://x/api/talk", { method: "POST", headers: { "content-type": "audio/webm;codecs=opus" }, body: "abc" }));
const sent = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

afterEach(() => {
  mock.restore();
  delete process.env.ECHO;
});

const proc = (stdout: string, code = 0, stderr = "") =>
  ({ stdout: new Response(stdout).body, stderr: new Response(stderr).body, exited: Promise.resolve(code) }) as any;
const sandbox = (stdout: string, code = 0, stderr = "") => spyOn(Bun, "spawn").mockReturnValue(proc(stdout, code, stderr));

test("talk transcribes the recording, runs the harness in a sandbox, and speaks its reply", async () => {
  const gemini = spyOn(globalThis, "fetch").mockResolvedValueOnce(heard("hello there")).mockResolvedValueOnce(spoken());
  const spawn = sandbox("The sandbox heard: hello there. It has 1 notes.\n");
  const res = await post();

  const [cmd, opts] = spawn.mock.calls[0] as [string[], { stdin: Blob }];
  expect(cmd.slice(0, 3)).toEqual(["docker", "run", "--rm"]);
  expect(cmd).toContain("--read-only");
  expect(cmd.join(" ")).toContain("--network none");
  expect(cmd.join(" ")).toContain(`-v ${import.meta.dir}/notes/1:/notes`);
  expect(existsSync(`${import.meta.dir}/notes/1`)).toBe(true);
  expect(await opts.stdin.text()).toBe("hello there");

  const [stt, tts] = gemini.mock.calls;
  expect(stt[0]).toContain("gemini-3.5-transcribe:generateContent");
  expect(sent(stt).contents[0].parts[0].inlineData).toEqual({ mimeType: "audio/webm", data: "YWJj" });
  expect(tts[0]).toContain("gemini-3.8-flash-tts:generateContent");
  expect(sent(tts)).toEqual({
    contents: [{ parts: [{ text: "The sandbox heard: hello there. It has 1 notes." }] }],
    generationConfig: { responseModalities: ["AUDIO"] },
  });

  expect(res.headers.get("content-type")).toBe("audio/wav");
  expect(decodeURIComponent(res.headers.get("x-transcript")!)).toBe("hello there");
  expect(Buffer.from(await res.arrayBuffer())).toEqual(WAV);
});

test("Accept: audio/ogg turns the reply into an OGG/Opus voice note", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(heard("hello there")).mockResolvedValueOnce(spoken());
  const spawn = spyOn(Bun, "spawn").mockReturnValueOnce(proc("The sandbox heard: hello there.")).mockReturnValueOnce(proc("OggS..."));
  const res = await talk(
    new Request("http://x/api/talk", { method: "POST", headers: { "content-type": "audio/ogg", accept: "audio/ogg" }, body: "abc" }),
  );

  const [cmd, opts] = spawn.mock.calls[1] as [string[], { stdin: Blob }];
  expect(cmd[0]).toBe("ffmpeg");
  expect(cmd.join(" ")).toContain("-c:a libopus");
  expect(cmd.join(" ")).toContain("-f ogg");
  expect(Buffer.from(await opts.stdin.arrayBuffer())).toEqual(WAV);
  expect(res.headers.get("content-type")).toBe("audio/ogg");
  expect(await res.text()).toBe("OggS...");
});

test("talk says so when it heard nothing, without starting a sandbox", async () => {
  const gemini = spyOn(globalThis, "fetch").mockResolvedValueOnce(heard("")).mockResolvedValueOnce(spoken());
  const spawn = sandbox("");
  await post();
  expect(spawn).not.toHaveBeenCalled();
  expect(sent(gemini.mock.calls[1]).contents[0].parts[0].text).toBe("I didn't catch that.");
});

test("talk surfaces a sandbox failure", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(heard("hello there"));
  sandbox("", 125, "Cannot connect to the Docker daemon");
  const res = await post();
  expect(res.status).toBe(502);
  expect(await res.text()).toContain("docker exited 125: Cannot connect to the Docker daemon");
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
