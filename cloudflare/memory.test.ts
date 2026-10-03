import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { generateMorningBriefing } from "./agent";
import { WorkerMemory, safePath } from "./memory";

afterEach(() => mock.restore());

class Bucket {
  objects = new Map<string, string>();
  async head(key: string) { return this.objects.has(key) ? { key } : null; }
  async get(key: string) {
    const value = this.objects.get(key);
    return value === undefined ? null : { text: async () => value };
  }
  async put(key: string, value: string, options?: R2PutOptions) {
    if (options?.onlyIf && this.objects.has(key)) return null;
    this.objects.set(key, value);
    return { key };
  }
  async list({ prefix }: R2ListOptions) {
    return { objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix ?? "")).map((key) => ({ key })), truncated: false };
  }
}

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
    candidates: [{ content: { role: "model", parts: [{ text: "## Today\n\n- Discuss deployment with Erik." }] } }],
  }));
  const env = { MEMORY: bucket, GEMINI_API_KEY: "test", HARNESS_MODEL: "gemini-3.8-flash" } as any;

  const first = await generateMorningBriefing(env, "user-a", "2026-10-03", "Europe/Stockholm");
  const second = await generateMorningBriefing(env, "user-a", "2026-10-03", "Europe/Stockholm");

  expect(first).toMatchObject({ path: "/briefings/2026-10-03.md", created: true });
  expect(second).toMatchObject({ content: first.content, created: false });
  expect(gemini).toHaveBeenCalledTimes(1);
  expect((await memory.read("/briefings/2026-10-03.md")).content).toContain("Discuss deployment with Erik");
});
