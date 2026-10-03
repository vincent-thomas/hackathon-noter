import { mkdir } from "node:fs/promises";
import { poll } from "./telegram";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

// Blob and Response only take buffers over a plain ArrayBuffer, which is all we ever make.
type Bytes = Buffer<ArrayBuffer>;

async function gemini(model: string, body: object): Promise<any[]> {
  const res = await fetch(`${API}/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${model} ${res.status}: ${await res.text()}`);
  return (await res.json()).candidates?.[0]?.content?.parts ?? [];
}

async function transcribe(audio: ArrayBuffer, mimeType: string): Promise<string> {
  const parts = await gemini("gemini-3.5-transcribe", {
    contents: [{ parts: [{ inlineData: { mimeType, data: Buffer.from(audio).toString("base64") } }] }],
  });
  // The transcript comes in an audioTranscription part, not in text.
  return parts.find((p) => p.audioTranscription)?.audioTranscription.text ?? "";
}

async function speak(text: string): Promise<Bytes> {
  const parts = await gemini("gemini-3.8-flash-tts", {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ["AUDIO"] },
  });
  // Already a complete WAV file, C2PA provenance chunk included.
  return Buffer.from(parts.find((p) => p.inlineData).inlineData.data, "base64");
}

// Users don't exist yet; every request belongs to user 1.
const USER_ID = 1;

async function run(cmd: string[], input: string | Bytes): Promise<Bytes> {
  const proc = Bun.spawn(cmd, { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${err}`);
  return Buffer.from(out);
}

// One throwaway container per request. The user's notes folder is its only writable path.
// The proof-of-concept harness just files the transcript and reports the count.
async function harness(transcript: string): Promise<string> {
  const notes = `${import.meta.dir}/notes/${USER_ID}`;
  await mkdir(notes, { recursive: true });
  const reply = await run([
    "docker", "run", "--rm", "-i", "--network", "none", "--cap-drop", "ALL", "--memory", "256m", "--read-only",
    "-v", `${notes}:/notes`, "alpine",
    "sh", "-c", 't=$(cat); echo "$t" >> /notes/notes.txt; echo "The sandbox heard: $t. It has $(wc -l < /notes/notes.txt) notes."',
  ], transcript);
  return reply.toString().trim();
}

const kb = (bytes: { byteLength: number }) => `${Math.round(bytes.byteLength / 1024)} KB`;

async function timed<T>(step: string, work: Promise<T>, describe: (result: T) => string): Promise<T> {
  const start = performance.now();
  const result = await work;
  console.log(`${step}: ${Math.round(performance.now() - start)} ms → ${describe(result)}`);
  return result;
}

// Audio in, spoken WAV reply out. The web page, and later Telegram and WhatsApp, all go through here.
export async function converse(audio: ArrayBuffer, mimeType: string): Promise<{ transcript: string; reply: Bytes }> {
  console.log(`converse: ${kb(audio)} of ${mimeType}`);
  const transcript = await timed("transcribe", transcribe(audio, mimeType), JSON.stringify);
  const answer = transcript ? await timed("harness", harness(transcript), JSON.stringify) : "I didn't catch that.";
  const reply = await timed("speak", speak(answer), kb);
  return { transcript, reply };
}

// WhatsApp and Telegram only show OGG/Opus as a voice note.
export function toVoiceNote(wav: Bytes): Promise<Bytes> {
  return timed("voice note", run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "32k", "-ac", "1", "-f", "ogg", "pipe:1"], wav), kb);
}

// Accept: audio/ogg gets a voice note, so a WhatsApp or Telegram round trip can be tried with curl.
export async function talk(req: Request): Promise<Response> {
  const recording = await req.arrayBuffer();
  const mimeType = req.headers.get("content-type")!.split(";")[0];
  // ECHO=1 skips Gemini, so debugging the page costs no tokens.
  if (process.env.ECHO === "1") {
    console.log(`echo: ${kb(recording)} of ${mimeType}`);
    return new Response(recording, { headers: { "content-type": mimeType, "x-transcript": "(echo)" } });
  }
  try {
    const { transcript, reply } = await converse(recording, mimeType);
    const voiceNote = req.headers.get("accept")?.includes("audio/ogg");
    return new Response(voiceNote ? await toVoiceNote(reply) : reply, {
      headers: { "content-type": voiceNote ? "audio/ogg" : "audio/wav", "x-transcript": encodeURIComponent(transcript) },
    });
  } catch (err) {
    console.error("talk failed:", err);
    return new Response(String(err), { status: 502 });
  }
}

if (import.meta.main) {
  const server = Bun.serve({
    port: 3000,
    routes: {
      "/": Bun.file(new URL("index.html", import.meta.url)),
      "/api/talk": { POST: talk },
    },
  });
  console.log(`listening on ${server.url}`);
  if (process.env.TELEGRAM_BOT_TOKEN) poll();
}
