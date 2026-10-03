import { getModels } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { resolve } from "node:path";
import { MemoryHarness } from "./memory";
import { createMemoryTools } from "./tools";

export const MEMORY_AGENT_SYSTEM_PROMPT = `You maintain the user's external memory.

The user gives the system unstructured captures containing thoughts, tasks, facts, ideas, plans, observations, and other information.

The /inbox directory contains raw source captures written by the backend. You may read and search /inbox, but you may never write to it. Everything outside /inbox is derived memory.

Existing memory files are immutable. write_memory can only create new files and fails if the path already exists.

When processing a capture:
- Read the raw capture first.
- Determine which information has future value and is useful to retain.
- Search existing memory when previous context may help interpret the capture or avoid duplication.
- Create useful derived memories with write_memory.
- Create multiple memories when a capture contains meaningfully separate information.
- Use /tasks for actionable commitments, /events for time-associated information, and /memory for other durable context. These are soft categories.
- Use concise, human-readable filenames and Markdown content.
- Avoid redundant or low-value memory.
- Preserve relevant context and uncertainty.
- Do not force every input into a task.
- Do not invent facts the user did not provide.
- If new information changes older memory, create a new memory describing the update rather than editing the old file.
- Supply a new unique id and the current offset-aware ISO timestamp for every write.`;

export const MEMORY_QUERY_SYSTEM_PROMPT = `You answer questions using the user's external memory.

Use list_memory, search_memory, and read_memory to find relevant information. The filesystem is the only source of truth. Do not claim facts that are absent from it. Clearly say when the stored memory is insufficient or contradictory. Give a concise, useful answer and cite supporting virtual file paths. You have read-only access and cannot create or alter memory.`;

export type AgentTraceEvent =
  | { type: "tool_start"; tool: string; input: unknown }
  | { type: "tool_end"; tool: string; isError: boolean }
  | { type: "assistant"; text: string };

export function resolveGoogleModel(modelId: string) {
  const registered = getModels("google").find((candidate) => candidate.id === modelId);
  if (registered) return registered;
  if (modelId === "gemini-3.8-flash") {
    const flash = getModels("google").find((candidate) => candidate.id === "gemini-flash-latest");
    if (!flash) throw new Error("Pi has no Google Flash model template");
    return { ...flash, id: modelId, name: "Gemini 3.8 Flash" };
  }
  throw new Error(`unknown Google model: ${modelId}`);
}

export async function processCapture(options: {
  sandboxRoot: string;
  capturePath: string;
  model?: string;
  onEvent?: (event: AgentTraceEvent) => void;
}): Promise<{ createdPaths: string[]; response: string }> {
  const harness = new MemoryHarness(options.sandboxRoot);
  const before = new Set((await harness.searchMemory({})).files.map((file) => file.path));
  const tools = createMemoryTools(harness);
  const cwd = resolve(import.meta.dir, "..");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: MEMORY_AGENT_SYSTEM_PROMPT,
    appendSystemPrompt: [],
  });
  await loader.reload();
  const modelId = options.model ?? "gemini-3.8-flash";
  const model = resolveGoogleModel(modelId);

  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: "low",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    noTools: "builtin",
    tools: tools.map((tool) => tool.name),
    customTools: tools,
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      options.onEvent?.({ type: "tool_start", tool: event.toolName, input: event.args });
    } else if (event.type === "tool_execution_end") {
      options.onEvent?.({ type: "tool_end", tool: event.toolName, isError: event.isError });
    }
  });

  try {
    await session.prompt(`A new capture was written to ${options.capturePath}.
Current time: ${new Date().toISOString()}
Process it into useful durable memory.`);
    const last = session.messages.at(-1);
    if (last?.role === "assistant" && last.errorMessage) throw new Error(last.errorMessage);
    const response = session.getLastAssistantText() ?? "";
    options.onEvent?.({ type: "assistant", text: response });
    const after = await harness.searchMemory({});
    return {
      createdPaths: after.files.map((file) => file.path).filter((path) => !before.has(path)),
      response,
    };
  } finally {
    unsubscribe();
    session.dispose();
  }
}

export async function queryMemory(options: {
  sandboxRoot: string;
  question: string;
  model?: string;
  onEvent?: (event: AgentTraceEvent) => void;
}): Promise<string> {
  if (!options.question.trim()) throw new Error("query cannot be empty");
  const harness = new MemoryHarness(options.sandboxRoot);
  const tools = createMemoryTools(harness).filter((tool) => tool.name !== "write_memory");
  const cwd = resolve(import.meta.dir, "..");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: MEMORY_QUERY_SYSTEM_PROMPT,
    appendSystemPrompt: [],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    model: resolveGoogleModel(options.model ?? "gemini-3.8-flash"),
    thinkingLevel: "low",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    noTools: "builtin",
    tools: tools.map((tool) => tool.name),
    customTools: tools,
  });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      options.onEvent?.({ type: "tool_start", tool: event.toolName, input: event.args });
    } else if (event.type === "tool_execution_end") {
      options.onEvent?.({ type: "tool_end", tool: event.toolName, isError: event.isError });
    }
  });

  try {
    await session.prompt(`Current time: ${new Date().toISOString()}\n\nQuestion: ${options.question}`);
    const last = session.messages.at(-1);
    if (last?.role === "assistant" && last.errorMessage) throw new Error(last.errorMessage);
    const response = session.getLastAssistantText() ?? "";
    options.onEvent?.({ type: "assistant", text: response });
    return response;
  } finally {
    unsubscribe();
    session.dispose();
  }
}
