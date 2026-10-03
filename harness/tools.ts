import { z } from "zod";
import { MemoryHarness } from "./memory";
import {
  ListMemoryInputSchema,
  ReadMemoryInputSchema,
  SearchMemoryInputSchema,
  WriteMemoryInputSchema,
} from "./schemas";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

export type MemoryTool = {
  name: "read_memory" | "list_memory" | "search_memory" | "write_memory";
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, input: unknown) => Promise<ToolResult>;
};

function result(details: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

/** Pi-compatible custom tools. Pass these as the session's only tools. */
export function createMemoryTools(harness: MemoryHarness): MemoryTool[] {
  return [
    {
      name: "read_memory",
      label: "Read memory",
      description: "Read one known Markdown memory file by its virtual path.",
      parameters: z.toJSONSchema(ReadMemoryInputSchema),
      execute: async (_id, input) => result(await harness.readMemory(input)),
    },
    {
      name: "list_memory",
      label: "List memory",
      description: "Deterministically list Markdown files below a memory directory.",
      parameters: z.toJSONSchema(ListMemoryInputSchema),
      execute: async (_id, input) => result(await harness.listMemory(input)),
    },
    {
      name: "search_memory",
      label: "Search memory",
      description: "Search memory deterministically by path, case-insensitive content, and exact frontmatter.",
      parameters: z.toJSONSchema(SearchMemoryInputSchema),
      execute: async (_id, input) => result(await harness.searchMemory(input)),
    },
    {
      name: "write_memory",
      label: "Write memory",
      description: "Create one new derived Markdown memory. Existing files and /inbox cannot be written.",
      parameters: z.toJSONSchema(WriteMemoryInputSchema),
      execute: async (_id, input) => result(await harness.writeMemory(input)),
    },
  ];
}
