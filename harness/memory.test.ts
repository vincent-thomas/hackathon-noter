import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryHarness } from "./memory";
import { serializeMarkdown } from "./markdown";
import { createMemoryTools } from "./tools";

const CREATED_AT = "2026-10-03T12:15:11+02:00";
const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "noter-harness-"));
  roots.push(root);
  const harness = new MemoryHarness(root);
  await harness.listMemory({ path: "/inbox" });
  return { root, harness };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MemoryHarness", () => {
  test("creates the five memory directories and writes then reads derived memory", async () => {
    const { harness } = await setup();
    const written = await harness.writeMemory({
      path: "/memory/docker-image-size-hypothesis.md",
      frontmatter: { id: "01K7T04QR5", created_at: CREATED_AT },
      content: "# Docker image size\n\nThe image may cause startup latency.",
    });

    expect(written.path).toBe("/memory/docker-image-size-hypothesis.md");
    expect(await harness.readMemory({ path: written.path })).toEqual(written);
    expect(await harness.listMemory({ path: "/memory" })).toEqual({ files: [written.path] });
    expect(await harness.listMemory({ path: "/inbox" })).toEqual({ files: [] });
  });

  test("is atomically create-only and never writes inbox", async () => {
    const { harness } = await setup();
    const input = {
      path: "/tasks/talk-to-erik.md",
      frontmatter: { id: "task-1", created_at: CREATED_AT },
      content: "# Talk to Erik",
    };
    await harness.writeMemory(input);
    await expect(harness.writeMemory(input)).rejects.toThrow("memory already exists: /tasks/talk-to-erik.md");
    await expect(harness.writeMemory({ ...input, path: "/inbox/no.md" })).rejects.toThrow(
      "write_memory cannot write to /inbox",
    );
  });

  test("validates strict frontmatter according to the file directory", async () => {
    const { root, harness } = await setup();
    await harness.listMemory({ path: "/inbox" });
    await writeFile(
      join(root, "inbox", "capture.md"),
      serializeMarkdown({ id: "capture-1", created_at: CREATED_AT, source: "voice" }, "hello"),
    );
    expect((await harness.readMemory({ path: "/inbox/capture.md" })).frontmatter).toEqual({
      id: "capture-1",
      created_at: CREATED_AT,
      source: "voice",
    });

    await writeFile(
      join(root, "memory", "bad.md"),
      "---\nid: bad\ncreated_at: 2026-10-03T12:15:11+02:00\nsource: voice\n---\n\nNo source allowed.\n",
    );
    await expect(harness.readMemory({ path: "/memory/bad.md" })).rejects.toThrow();
  });

  test("searches deterministically with combined constraints", async () => {
    const { harness } = await setup();
    await harness.writeMemory({
      path: "/tasks/deploy.md",
      frontmatter: { id: "one", created_at: CREATED_AT },
      content: "Discuss Deployment with Erik.",
    });
    await harness.writeMemory({
      path: "/memory/deploy.md",
      frontmatter: { id: "two", created_at: CREATED_AT },
      content: "Deployment image hypothesis.",
    });

    const result = await harness.searchMemory({
      path: "/tasks",
      contains: "deployment",
      frontmatter: { id: "one" },
    });
    expect(result.files.map((file) => file.path)).toEqual(["/tasks/deploy.md"]);
    expect((await harness.searchMemory({ contains: "DEPLOYMENT" })).files.map((file) => file.path)).toEqual([
      "/memory/deploy.md",
      "/tasks/deploy.md",
    ]);
  });

  test("rejects an exact copy of an existing memory", async () => {
    const { harness } = await setup();
    const frontmatter = { id: "one", created_at: CREATED_AT };
    await harness.writeMemory({ path: "/tasks/dentist.md", content: "Dentist on Friday at 4.", frontmatter });
    await expect(
      harness.writeMemory({ path: "/tasks/dentist-repeat.md", content: " Dentist on Friday at 4.\n", frontmatter: { ...frontmatter, id: "two" } }),
    ).rejects.toThrow("already recorded in /tasks/dentist.md");
    expect((await harness.listMemory({ path: "/tasks" })).files).toEqual(["/tasks/dentist.md"]);
  });

  test("rejects empty memories, which the model writes as placeholders", async () => {
    const { harness } = await setup();
    const input = { path: "/memory/dummy.md", frontmatter: { id: "dummy", created_at: CREATED_AT } };
    await expect(harness.writeMemory({ ...input, content: "" })).rejects.toThrow("memory content cannot be empty");
    await expect(harness.writeMemory({ ...input, content: " \n " })).rejects.toThrow("memory content cannot be empty");
    expect((await harness.listMemory({ path: "/memory" })).files).toEqual([]);
  });

  test("rejects traversal, host paths, invalid extensions, and symlink escape", async () => {
    const { root, harness } = await setup();
    const input = {
      frontmatter: { id: "one", created_at: CREATED_AT },
      content: "unsafe",
    };
    await expect(harness.writeMemory({ ...input, path: "/tasks/../../../escape.md" })).rejects.toThrow(
      "invalid memory path",
    );
    await expect(harness.readMemory({ path: "/etc/passwd" })).rejects.toThrow("invalid memory path");
    await expect(harness.writeMemory({ ...input, path: "/tasks/not-markdown.txt" })).rejects.toThrow(
      "must end in .md",
    );

    await harness.listMemory({ path: "/memory" });
    await symlink(tmpdir(), join(root, "memory", "outside"));
    await expect(harness.writeMemory({ ...input, path: "/memory/outside/escape.md" })).rejects.toThrow(
      "unsafe sandbox path",
    );
    await expect(harness.writeMemory({ ...input, path: "/memory/outside/new/escape.md" })).rejects.toThrow(
      "unsafe sandbox path",
    );
  });

  test("exposes exactly the four narrow Pi-compatible tools", async () => {
    const { harness } = await setup();
    const tools = createMemoryTools(harness);
    expect(tools.map((tool) => tool.name)).toEqual([
      "read_memory",
      "list_memory",
      "search_memory",
      "write_memory",
    ]);
    expect(tools.every((tool) => tool.parameters["type"] === "object")).toBe(true);
  });
});
