import { mkdir } from "node:fs/promises";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

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

async function speak(text: string): Promise<Buffer> {
  const parts = await gemini("gemini-3.8-flash-tts", {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ["AUDIO"] },
  });
  // Already a complete WAV file, C2PA provenance chunk included.
  return Buffer.from(parts.find((p) => p.inlineData).inlineData.data, "base64");
}

// Users don't exist yet; every request belongs to user 1.
const USER_ID = 1;

// One throwaway container per request. The user's notes folder is its only writable path.
// The proof-of-concept harness just files the transcript and reports the count.
async function harness(transcript: string): Promise<string> {
  const notes = `${import.meta.dir}/notes/${USER_ID}`;
  await mkdir(notes, { recursive: true });
  const proc = Bun.spawn([
    "docker", "run", "--rm", "-i", "--network", "none", "--cap-drop", "ALL", "--memory", "256m", "--read-only",
    "-v", `${notes}:/notes`, "alpine",
    "sh", "-c", 't=$(cat); echo "$t" >> /notes/notes.txt; echo "The sandbox heard: $t. It has $(wc -l < /notes/notes.txt) notes."',
  ], { stdin: new Blob([transcript]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`sandbox exited ${code}: ${err}`);
  return out.trim();
}

export async function talk(req: Request): Promise<Response> {
  const recording = await req.arrayBuffer();
  const mimeType = req.headers.get("content-type")!.split(";")[0];
  // ECHO=1 skips Gemini, so debugging the page costs no tokens.
  if (process.env.ECHO === "1") return new Response(recording, { headers: { "content-type": mimeType, "x-transcript": "(echo)" } });
  try {
    const transcript = await transcribe(recording, mimeType);
    const audio = await speak(transcript ? await harness(transcript) : "I didn't catch that.");
    return new Response(audio, { headers: { "content-type": "audio/wav", "x-transcript": encodeURIComponent(transcript) } });
  } catch (err) {
    return new Response(String(err), { status: 502 });
  }
}

if (import.meta.main) {
  Bun.serve({
    port: 3000,
    routes: {
      "/": Bun.file(new URL("index.html", import.meta.url)),
      "/api/talk": { POST: talk },
    },
  });
}
