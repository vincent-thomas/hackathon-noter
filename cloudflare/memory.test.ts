import { expect, test } from "bun:test";
import { WorkerMemory, safePath } from "./memory";

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
