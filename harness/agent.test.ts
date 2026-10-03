import { expect, test } from "bun:test";
import { capturePrompt, MEMORY_AGENT_SYSTEM_PROMPT, MEMORY_QUERY_SYSTEM_PROMPT, resolveGoogleModel, trackAccessedPaths } from "./agent";

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

test("capture agent supports memory and questions in the same transcript", () => {
  expect(MEMORY_AGENT_SYSTEM_PROMPT).toContain("retain useful new information and answer any questions");
  expect(MEMORY_AGENT_SYSTEM_PROMPT).toContain("Do not create derived memory merely because the user asked a question");
  expect(MEMORY_AGENT_SYSTEM_PROMPT).toContain("Answer embedded questions directly");
});

test("the capture prompt carries the transcript and existing memory, so the agent needn't fetch them", () => {
  const capture = {
    path: "/inbox/2026-10-03--a.md",
    frontmatter: { id: "a", created_at: "2026-10-03T12:00:00Z", source: "voice" as const },
    content: "Ask Erik about the deployment.",
  };
  const prompt = capturePrompt(capture, ["/inbox/2026-10-03--a.md", "/inbox/older.md", "/tasks/erik.md", "/memory/docker.md"], new Date("2026-10-03T12:00:00Z"));

  expect(prompt).toContain("<capture>\nAsk Erik about the deployment.\n</capture>");
  expect(prompt).toContain("Existing memory files: /tasks/erik.md, /memory/docker.md\n");
  expect(prompt).toContain("Current time: 2026-10-03T12:00:00.000Z");
  expect(capturePrompt(capture, ["/inbox/older.md"], new Date())).toContain("Existing memory files: none yet");
  expect(MEMORY_AGENT_SYSTEM_PROMPT).toContain("Don't read or list them again");
});
