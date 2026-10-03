import { expect, test } from "bun:test";
import { liveTranscript } from "./live";

// Stands in for Gemini's live socket: records what we send, replays what Gemini would answer.
function fakeGemini() {
  const sent: any[] = [];
  const socket: any = { send: (data: string) => sent.push(JSON.parse(data)), close: () => (socket.closed = true) };
  const say = (message: object) => socket.onmessage({ data: JSON.stringify(message) });
  return { socket, sent, say, open: () => socket.onopen() };
}
const settle = () => Bun.sleep(0);

test("streams audio after setup and resolves with the final transcript", async () => {
  const gemini = fakeGemini();
  const live = liveTranscript(gemini.socket);
  live.feed(new Uint8Array([1, 2]));
  gemini.open();
  await gemini.say({ setupComplete: {} });
  await settle();
  await gemini.say({ voiceActivity: { type: "ACTIVITY_START" } });
  await gemini.say({ serverContent: { interimInputTranscription: { text: "Remind me" } } });

  const finished = live.finish();
  await settle();
  await gemini.say({ serverContent: { inputTranscription: { text: "Remind me to call Jeff." } } });
  await gemini.say({ serverContent: { generationComplete: true } });

  expect(await finished).toBe("Remind me to call Jeff.");
  expect(gemini.sent[0].setup.model).toBe("models/gemini-3.5-transcribe-live");
  expect(gemini.sent[1]).toEqual({ realtimeInput: { audio: { data: "AQI=", mimeType: "audio/pcm;rate=16000" } } });
  expect(gemini.sent[2]).toEqual({ realtimeInput: { audioStreamEnd: true } });
  expect(gemini.socket.closed).toBe(true);
});

test("silence finishes at once with an empty transcript, since Gemini sends nothing more", async () => {
  const gemini = fakeGemini();
  const live = liveTranscript(gemini.socket);
  gemini.open();
  await gemini.say({ setupComplete: {} });
  live.feed(new Uint8Array(4));
  expect(await live.finish()).toBe("");
});

test("a pause before the tap finishes at once with what was already transcribed", async () => {
  const gemini = fakeGemini();
  const live = liveTranscript(gemini.socket);
  gemini.open();
  await gemini.say({ setupComplete: {} });
  await gemini.say({ voiceActivity: { type: "ACTIVITY_START" } });
  await gemini.say({ serverContent: { inputTranscription: { text: "Buy milk." } } });
  await gemini.say({ serverContent: { generationComplete: true } });
  expect(await live.finish()).toBe("Buy milk.");
});

test("Gemini closing the connection fails the transcript", async () => {
  const gemini = fakeGemini();
  const live = liveTranscript(gemini.socket);
  gemini.open();
  await gemini.say({ setupComplete: {} });
  await gemini.say({ voiceActivity: { type: "ACTIVITY_START" } });
  const finished = live.finish();
  await settle();
  gemini.socket.onclose({ code: 1011, reason: "quota exceeded" });
  await expect(finished).rejects.toThrow("live transcription closed: 1011 quota exceeded");
});
