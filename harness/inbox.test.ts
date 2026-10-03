import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxCapture } from "./inbox";
import { MemoryHarness } from "./memory";
import { createMemoryTools } from "./tools";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test("backend ingestion creates a readable raw inbox capture", async () => {
  root = await mkdtemp(join(tmpdir(), "noter-inbox-"));
  const capture = await createInboxCapture(root, {
    source: "text",
    transcript: "Ask Erik about deployment tomorrow.",
  });
  const file = await new MemoryHarness(root).readMemory({ path: capture.path });

  expect(capture.path).toStartWith("/inbox/");
  expect(file.content).toBe("Ask Erik about deployment tomorrow.");
  expect(file.frontmatter).toMatchObject({ id: capture.id, source: "text" });
});

test("agent tool surface has no inbox-writing capability", async () => {
  root = await mkdtemp(join(tmpdir(), "noter-inbox-"));
  const harness = new MemoryHarness(root);
  await harness.listMemory({ path: "/inbox" });
  const tools = createMemoryTools(harness);
  expect(tools.map((tool) => tool.name)).toEqual([
    "read_memory",
    "list_memory",
    "search_memory",
    "write_memory",
  ]);
});
