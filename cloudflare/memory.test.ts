import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { generateMorningBriefing } from "./agent";
import { WorkerMemory, safePath } from "./memory";
import { Bucket } from "./test-bucket";

afterEach(() => mock.restore());

test("validates Worker virtual paths", () => {
  expect(safePath("/tasks/ask-erik.md")).toBe("/tasks/ask-erik.md");
  expect(safePath("/")).toBe("/");
  expect(() => safePath("/tasks/../../secret.md")).toThrow("invalid memory path");
  expect(() => safePath("/unknown/note.md")).toThrow("invalid memory path");
});

test("R2 memory remains isolated, searchable, and create-only", async () => {
  const bucket = new Bucket() as unknown as R2Bucket;
  const memory = new WorkerMemory(bucket, "user-a");
  const other = new WorkerMemory(bucket, "user-b");
  const frontmatter = { id: "memory-1", created_at: "2026-10-03T12:00:00.000Z" };

  await memory.createInbox("Ask Erik about deployment", "text");
  await memory.write({ path: "/tasks/ask-erik.md", frontmatter, content: "# Ask Erik\n\nDiscuss deployment." });

  expect((await memory.search({ contains: "DEPLOYMENT" })).files.map((file) => file.path)).toEqual([
    expect.stringContaining("/inbox/"),
    "/tasks/ask-erik.md",
  ]);
  expect((await other.search({})).files).toEqual([]);
  await expect(memory.write({ path: "/tasks/ask-erik.md", frontmatter, content: "replacement" })).rejects.toThrow("already exists");
  await expect(memory.write({ path: "/inbox/no.md", frontmatter, content: "no" })).rejects.toThrow("cannot write");
});

test("the briefing harness synthesizes and persists one daily artifact", async () => {
  const bucket = new Bucket() as unknown as R2Bucket;
  const memory = new WorkerMemory(bucket, "user-a");
  await memory.write({
    path: "/tasks/ask-erik.md",
    frontmatter: { id: "task-1", created_at: "2026-10-02T12:00:00.000Z" },
    content: "# Ask Erik\n\nDiscuss deployment today.",
  });
  const gemini = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    choices: [{ message: { role: "assistant", content: "## Today\n\n- Discuss deployment with Erik." } }],
  }));
  const env = { MEMORY: bucket, GEMINI_API_KEY: "test", CONDENSE_API_KEY: "condense", HARNESS_MODEL: "gemini-3.8-flash" } as any;

  const first = await generateMorningBriefing(env, "user-a", "2026-10-03", "Europe/Stockholm");
  const second = await generateMorningBriefing(env, "user-a", "2026-10-03", "Europe/Stockholm");

  expect(first).toMatchObject({ path: "/briefings/2026-10-03.md", created: true });
  expect(second).toMatchObject({ content: first.content, created: false });
  expect(gemini).toHaveBeenCalledTimes(1);
  expect((await memory.read("/briefings/2026-10-03.md")).content).toContain("Discuss deployment with Erik");
});

test("the Worker store refuses an exact copy of an existing memory", async () => {
  const memory = new WorkerMemory(new Bucket() as unknown as R2Bucket, "user-a");
  const frontmatter = { id: "task-1", created_at: "2026-10-02T12:00:00.000Z" };
  await memory.write({ path: "/tasks/dentist.md", frontmatter, content: "Dentist on Friday at 4." });
  await expect(memory.write({ path: "/tasks/dentist-repeat.md", frontmatter: { ...frontmatter, id: "task-2" }, content: "Dentist on Friday at 4.\n" }))
    .rejects.toThrow("already recorded in /tasks/dentist.md");
});

test("the Worker store refuses empty memories, which the model writes as placeholders", async () => {
  const memory = new WorkerMemory(new Bucket() as unknown as R2Bucket, "user-a");
  const frontmatter = { id: "dummy", created_at: "2026-10-02T12:00:00.000Z" };
  await expect(memory.write({ path: "/memory/dummy.md", frontmatter, content: " \n " })).rejects.toThrow("memory content cannot be empty");
});
