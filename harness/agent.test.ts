import { expect, test } from "bun:test";
import { MEMORY_QUERY_SYSTEM_PROMPT, resolveGoogleModel } from "./agent";

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

test("query contract is read-only and requires path citations", () => {
  expect(MEMORY_QUERY_SYSTEM_PROMPT).toContain("read-only access");
  expect(MEMORY_QUERY_SYSTEM_PROMPT).toContain("cite supporting virtual file paths");
});
