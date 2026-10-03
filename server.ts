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

// Repeats what you said; the harness goes between transcribe and speak.
export async function talk(req: Request): Promise<Response> {
  try {
    const transcript = await transcribe(await req.arrayBuffer(), req.headers.get("content-type")!.split(";")[0]);
    const audio = await speak(transcript || "I didn't catch that.");
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
