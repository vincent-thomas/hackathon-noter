import { expect, test } from "bun:test";
import { allInlined, capturePrompt, INLINE_MEMORY_BUDGET, MEMORY_AGENT_SYSTEM_PROMPT, MEMORY_QUERY_SYSTEM_PROMPT, resolveGoogleModel, trackAccessedPaths } from "./agent";

test("uses Gemini 3.8 Flash through Pi's Google Flash transport", () => {
  const model = resolveGoogleModel("gemini-3.8-flash");
  expect(model.id).toBe("gemini-3.8-flash");
  expect(model.name).toBe("Gemini 3.8 Flash");
  expect(model.provider).toBe("google");
  expect(model.api).toBe("google-generative-ai");
});

test("uses Gemini 3.5 Flash Lite through Pi's Google Flash Lite transport", () => {
  const model = resolveGoogleModel("gemini-3.5-flash-lite");
  expect(model.id).toBe("gemini-3.5-flash-lite");
  expect(model.provider).toBe("google");
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

const file = (path: string, content: string) => ({
  path,
  frontmatter: { id: path, created_at: "2026-10-02T09:00:00Z" },
  content,
});

test("the capture prompt carries the transcript and small memory whole, so the agent needn't fetch them", () => {
  const capture = { ...file("/inbox/2026-10-03--a.md", "What do I ask Erik?"), frontmatter: { id: "a", created_at: "2026-10-03T12:00:00Z", source: "voice" as const } };
  const { prompt, inlined } = capturePrompt(
    capture,
    [capture, file("/inbox/older.md", "raw"), file("/tasks/erik.md", "Ask Erik about the deployment.")],
    new Date("2026-10-03T12:00:00Z"),
  );

  expect(prompt).toContain("<capture>\nWhat do I ask Erik?\n</capture>");
  expect(prompt).toContain('<memory path="/tasks/erik.md" created_at="2026-10-02T09:00:00Z">\nAsk Erik about the deployment.\n</memory>');
  expect(prompt).not.toContain("raw");
  expect(prompt).toContain("Current time: 2026-10-03T12:00:00.000Z");
  expect(inlined).toEqual(["/tasks/erik.md"]);
  expect(capturePrompt(capture, [capture], new Date()).prompt).toContain("Existing memory: none yet");
  expect(MEMORY_AGENT_SYSTEM_PROMPT).toContain("Don't read or list what you were given");
});

test("over the budget, the capture prompt lists memory paths only", () => {
  const capture = file("/inbox/a.md", "hi");
  const big = file("/memory/big.md", "x".repeat(INLINE_MEMORY_BUDGET));
  const { prompt, inlined } = capturePrompt(capture, [big, file("/tasks/erik.md", "Ask Erik.")], new Date());

  expect(prompt).toContain("Existing memory files: /memory/big.md, /tasks/erik.md\n");
  expect(prompt).not.toContain("Ask Erik.");
  expect(inlined).toEqual([]);
});

test("all memory counts as inlined only when every derived file made it into the prompt", () => {
  const files = [file("/inbox/raw.md", "raw"), file("/tasks/erik.md", "Ask Erik.")];
  expect(allInlined(files, ["/tasks/erik.md"])).toBe(true);
  expect(allInlined(files, [])).toBe(false);
  expect(allInlined([file("/inbox/raw.md", "raw")], [])).toBe(true);
});
