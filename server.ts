const MODEL = "gemini-3.5-transcribe";

async function transcribe(audio: ArrayBuffer, mimeType: string): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
    body: JSON.stringify({
      contents: [{ parts: [{ inlineData: { mimeType, data: Buffer.from(audio).toString("base64") } }] }],
    }),
  });
  if (!res.ok) throw new Error(`${MODEL} ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  // The transcript comes in an audioTranscription part, not in text.
  return json.candidates?.[0]?.content?.parts?.find((p: any) => p.audioTranscription)?.audioTranscription.text ?? "";
}

// Echoes the recording back; harness → Gemini TTS replaces that.
export async function talk(req: Request): Promise<Response> {
  const audio = await req.arrayBuffer();
  const mimeType = req.headers.get("content-type")!.split(";")[0];
  try {
    const transcript = await transcribe(audio, mimeType);
    return new Response(audio, { headers: { "content-type": mimeType, "x-transcript": encodeURIComponent(transcript) } });
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
