import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { MemoryHarness } from "./memory";

function result(details: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

/** Pi-compatible custom tools. Pass these as the session's only tools. */
export function createMemoryTools(harness: MemoryHarness) {
  return [
    defineTool({
      name: "read_memory",
      label: "Read memory",
      description: "Read one known Markdown memory file by its virtual path.",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      execute: async (_id, input) => result(await harness.readMemory(input)),
    }),
    defineTool({
      name: "list_memory",
      label: "List memory",
      description: "Deterministically list Markdown files below a memory directory.",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      execute: async (_id, input) => result(await harness.listMemory(input)),
    }),
    defineTool({
      name: "search_memory",
      label: "Search memory",
      description: "Search memory deterministically by path, case-insensitive content, and exact frontmatter.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ minLength: 1 })),
        contains: Type.Optional(Type.String()),
        frontmatter: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
      }, { additionalProperties: false }),
      execute: async (_id, input) => result(await harness.searchMemory(input)),
    }),
    defineTool({
      name: "write_memory",
      label: "Write memory",
      description: "Create one new derived Markdown memory. Existing files and /inbox cannot be written.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        content: Type.String(),
        frontmatter: Type.Object({
          id: Type.String({ minLength: 1 }),
          created_at: Type.String({ format: "date-time" }),
        }, { additionalProperties: false }),
      }, { additionalProperties: false }),
      execute: async (_id, input) => result(await harness.writeMemory(input)),
    }),
  ];
}
