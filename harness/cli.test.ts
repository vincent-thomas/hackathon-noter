import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommand } from "./cli";
import { MemoryHarness } from "./memory";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test("CLI writes, lists, reads, and searches memory", async () => {
  root = await mkdtemp(join(tmpdir(), "noter-cli-"));
  const harness = new MemoryHarness(root);
  const output: string[] = [];
  const io = { write: (message: string) => output.push(message) };

  await executeCommand(harness, "write /tasks/talk-to-erik.md 'Talk to Erik about deployment tomorrow'", io);
  await executeCommand(harness, "list /tasks", io);
  await executeCommand(harness, "read /tasks/talk-to-erik.md", io);
  await executeCommand(harness, "search deployment /tasks", io);

  expect(output[0]).toBe("Created /tasks/talk-to-erik.md");
  expect(output[1]).toBe("/tasks/talk-to-erik.md");
  expect(output[2]).toContain("Talk to Erik about deployment tomorrow");
  expect(output[3]).toContain("/tasks/talk-to-erik.md");
});

test("CLI reports usage errors and exit", async () => {
  root = await mkdtemp(join(tmpdir(), "noter-cli-"));
  const harness = new MemoryHarness(root);
  const io = { write: () => undefined };

  await expect(executeCommand(harness, "write /tasks/no-content.md", io)).rejects.toThrow("usage: write");
  expect(await executeCommand(harness, "exit", io)).toBe("exit");
});

