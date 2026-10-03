// Gemini speech calls, shared by the Bun server and the Cloudflare Worker: plain fetch, no Node APIs.
const API = "https://generativelanguage.googleapis.com/v1beta/models";

// Blob and Response only take bytes over a plain ArrayBuffer, which is all we ever make.
export type Bytes = Uint8Array<ArrayBuffer>;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Spreading a huge array into String.fromCharCode overflows the stack, so it goes in chunks.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function fromBase64(encoded: string): Bytes {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function post(apiKey: string, model: string, method: string, body: object): Promise<Response> {
  const res = await fetch(`${API}/${model}:${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${model} ${res.status}: ${await res.text()}`);
  return res;
}

async function generate(apiKey: string, model: string, body: object): Promise<any[]> {
  return ((await (await post(apiKey, model, "generateContent", body)).json()) as any).candidates?.[0]?.content?.parts ?? [];
}

export async function transcribe(apiKey: string, audio: ArrayBuffer | Uint8Array, mimeType: string): Promise<string> {
  const parts = await generate(apiKey, "gemini-3.5-transcribe", {
    contents: [{ parts: [{ inlineData: { mimeType, data: toBase64(new Uint8Array(audio)) } }] }],
  });
  // The transcript comes in an audioTranscription part, not in text.
  return parts.find((p) => p.audioTranscription)?.audioTranscription.text ?? "";
}

// The lite model streams about twice as fast: first audio in ~0.7 s instead of ~1.2 s.
const TTS = "gemini-3.8-flash-lite-tts";
// Without a fixed voice, Gemini picks a different speaker per reply. Algenib is the gravelly one.
const VOICE = "Algenib";
const ttsRequest = (text: string) => ({
  contents: [{ parts: [{ text }] }],
  generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
});

/** A complete WAV file, C2PA provenance chunk included. */
export async function speak(apiKey: string, text: string): Promise<Bytes> {
  const audio = (await generate(apiKey, TTS, ttsRequest(text))).find((p) => p.inlineData)?.inlineData.data;
  if (!audio) throw new Error(`${TTS} returned no audio`);
  return fromBase64(audio);
}

// Streamed TTS is bare 24 kHz mono 16-bit PCM, sent as it's generated: the first audio arrives
// in about 1 s instead of the whole reply in 3–4 s. Chunks are cut to whole samples.
export async function* speakStream(apiKey: string, text: string): AsyncGenerator<Bytes> {
  const start = performance.now();
  const res = await post(apiKey, TTS, "streamGenerateContent?alt=sse", ttsRequest(text));
  const decoder = new TextDecoder();
  let events = "";
  let halfSample: Bytes | undefined;
  let bytes = 0;
  for await (const chunk of res.body!) {
    events = (events + decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n");
    for (let end = events.indexOf("\n\n"); end >= 0; end = events.indexOf("\n\n")) {
      const data = events.slice(0, end).split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("");
      events = events.slice(end + 2);
      if (!data) continue;
      const event = JSON.parse(data);
      if (event.error) throw new Error(`${TTS} stream: ${JSON.stringify(event.error)}`);
      for (const part of event.candidates?.[0]?.content?.parts ?? []) {
        if (!part.inlineData) continue;
        let pcm = fromBase64(part.inlineData.data);
        if (halfSample) {
          const joined = new Uint8Array(halfSample.length + pcm.length);
          joined.set(halfSample);
          joined.set(pcm, halfSample.length);
          pcm = joined;
        }
        const whole = pcm.length - (pcm.length % 2);
        halfSample = whole < pcm.length ? pcm.slice(whole) : undefined;
        if (!whole) continue;
        if (!bytes) console.log(`speak (stream): first audio after ${Math.round(performance.now() - start)} ms`);
        bytes += whole;
        yield pcm.slice(0, whole);
      }
    }
  }
  console.log(`speak (stream): ${Math.round(performance.now() - start)} ms → ${Math.round(bytes / 1024)} KB`);
}

// Waits for the first chunk, so a TTS failure still gets a clean 502 instead of a silent 200.
export async function pcmResponse(audio: AsyncGenerator<Bytes>, headers: Record<string, string>): Promise<Response> {
  const first = await audio.next();
  const body = new ReadableStream<Bytes>({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(first.value);
    },
    async pull(controller) {
      try {
        const next = await audio.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (err) {
        console.error("speak (stream) failed mid-reply:", err);
        controller.error(err);
      }
    },
    async cancel() {
      await audio.return(undefined);
    },
  });
  return new Response(body, { headers: { ...headers, "content-type": "audio/l16; rate=24000; channels=1" } });
}
