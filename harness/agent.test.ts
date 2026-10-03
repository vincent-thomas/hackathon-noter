import { expect, test } from "bun:test";
import { MEMORY_QUERY_SYSTEM_PROMPT, resolveGoogleModel, trackAccessedPaths } from "./agent";

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

test("query contract is read-only and hides provenance from the answer", () => {
  expect(MEMORY_QUERY_SYSTEM_PROMPT).toContain("read-only access");
  expect(MEMORY_QUERY_SYSTEM_PROMPT).toContain("Do not include source citations");
});

test("tracks files consulted through read, search, and list tools", () => {
  const paths = new Set<string>();
  trackAccessedPaths("read_memory", { path: "/tasks/erik.md" }, paths);
  trackAccessedPaths("search_memory", { files: [{ path: "/memory/startup.md" }] }, paths);
  trackAccessedPaths("list_memory", { files: ["/events/demo.md"] }, paths);
  expect([...paths].sort()).toEqual([
    "/events/demo.md",
    "/memory/startup.md",
    "/tasks/erik.md",
  ]);
});
