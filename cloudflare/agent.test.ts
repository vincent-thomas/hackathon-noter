import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { captureMemory } from "./agent";
import { WorkerMemory } from "./memory";
import { Bucket } from "./test-bucket";

afterEach(() => mock.restore());

const model = (parts: object[]) => Response.json({ candidates: [{ content: { role: "model", parts } }] });

test("a write without frontmatter still files the memory; the Worker fills in id and timestamp", async () => {
  // The shape gemini-3.5-flash-lite actually sent: no frontmatter, a stray top-level id.
  spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(model([{ functionCall: { name: "write_memory", args: { id: "tasks/dentist", path: "/tasks/dentist.md", content: "Dentist on Friday at 4." } } }]))
    .mockResolvedValueOnce(model([{ text: "Noted." }]));
  const bucket = new Bucket();
  const env = { MEMORY: bucket, GEMINI_API_KEY: "k" } as any;

  const result = await captureMemory(env, "user-1", "Dentist on Friday at 4.", "voice");

  expect(result.createdPaths).toEqual(["/tasks/dentist.md"]);
  const file = await new WorkerMemory(bucket as unknown as R2Bucket, "user-1").read("/tasks/dentist.md");
  expect(file.content.trim()).toBe("Dentist on Friday at 4.");
  expect(file.frontmatter.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(Date.parse(file.frontmatter.created_at)).toBeGreaterThan(0);
});
