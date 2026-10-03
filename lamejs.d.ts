// lamejs ships no types; only what mp3.ts uses.
declare module "lamejs" {
  const lamejs: {
    Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => {
      encodeBuffer(samples: Int16Array): Int8Array;
      flush(): Int8Array;
    };
  };
  export default lamejs;
}
declare module "lamejs/src/js/*" {
  const module: unknown;
  export default module;
}
