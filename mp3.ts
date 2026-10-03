// Telegram shows MP3 as a voice message, and unlike Opus it can be encoded in plain JavaScript,
// which a Worker can run: no ffmpeg there.
import lamejs from "lamejs";
import BitStream from "lamejs/src/js/BitStream";
import Lame from "lamejs/src/js/Lame";
import MPEGMode from "lamejs/src/js/MPEGMode";

// lamejs's modules read these as browser globals; without them every encoder throws.
Object.assign(globalThis, { MPEGMode, Lame, BitStream });

/** Raw 24 kHz mono 16-bit PCM, as Gemini's TTS streams it, in; a 48 kbps MP3 out. */
export function toMp3(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
  const encoder = new lamejs.Mp3Encoder(1, 24000, 48);
  const parts: Int8Array[] = [encoder.encodeBuffer(samples), encoder.flush()];
  const mp3 = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    mp3.set(new Uint8Array(part.buffer, part.byteOffset, part.length), offset);
    offset += part.length;
  }
  return mp3;
}
