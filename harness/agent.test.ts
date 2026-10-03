import { expect, test } from "bun:test";
import { resolveGoogleModel } from "./agent";

test("uses Gemini 3.8 Flash through Pi's Google Flash transport", () => {
  const model = resolveGoogleModel("gemini-3.8-flash");
  expect(model.id).toBe("gemini-3.8-flash");
  expect(model.name).toBe("Gemini 3.8 Flash");
  expect(model.provider).toBe("google");
  expect(model.api).toBe("google-generative-ai");
});

test("rejects unknown custom Google models", () => {
  expect(() => resolveGoogleModel("made-up-model")).toThrow("unknown Google model");
});

