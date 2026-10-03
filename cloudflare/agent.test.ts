import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { captureMemory } from "./agent";
import { WorkerMemory } from "./memory";
import { Bucket } from "./test-bucket";

afterEach(() => mock.restore());

const completion = (message: object) => Response.json({ choices: [{ message: { role: "assistant", ...message } }] });

test("a write without frontmatter still files the memory; the Worker fills in id and timestamp", async () => {
  const fetch = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(completion({ content: null, tool_calls: [{
      id: "call-1",
      type: "function",
      function: { name: "write_memory", arguments: JSON.stringify({ id: "tasks/dentist", path: "/tasks/dentist.md", content: "Dentist on Friday at 4." }) },
    }] }))
    .mockResolvedValueOnce(completion({ content: "Noted." }));
  const bucket = new Bucket();
  const env = { MEMORY: bucket, GEMINI_API_KEY: "gemini-key", CONDENSE_API_KEY: "condense-key" } as any;

  const result = await captureMemory(env, "user-1", "Dentist on Friday at 4.", "voice");

  expect(result.createdPaths).toEqual(["/tasks/dentist.md"]);
  const file = await new WorkerMemory(bucket as unknown as R2Bucket, "user-1").read("/tasks/dentist.md");
  expect(file.content.trim()).toBe("Dentist on Friday at 4.");
  expect(file.frontmatter.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(Date.parse(file.frontmatter.created_at)).toBeGreaterThan(0);
  expect(fetch.mock.calls[0][0]).toBe("https://api.condense.chat/openai/v1/chat/completions");
  const request = fetch.mock.calls[0][1] as RequestInit;
  expect(request.headers).toEqual(expect.objectContaining({
    authorization: "Bearer gemini-key",
    "x-condense-auth-token": "condense-key",
    "x-condense-upstream-url": "https://generativelanguage.googleapis.com/v1beta/openai",
  }));
  expect(JSON.parse(String(request.body)).model).toBe("gemini-3.5-flash-lite");
});
