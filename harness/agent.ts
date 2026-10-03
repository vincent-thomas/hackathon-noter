import { getModels } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { resolve } from "node:path";
import { MemoryHarness } from "./memory";
import { isInboxPath } from "./paths";
import type { MemoryFile } from "./schemas";
import { createMemoryTools } from "./tools";

export const MEMORY_AGENT_SYSTEM_PROMPT = `You maintain the user's external memory.

The user gives the system unstructured transcripts containing thoughts, tasks, facts, ideas, plans, observations, questions, and mixtures of these.

The /inbox directory contains raw source captures written by the backend. You may read and search /inbox, but you may never write to it. Everything outside /inbox is derived memory.

Existing memory files are immutable. write_memory can only create new files and fails if the path already exists.

When processing a capture:
- The raw capture's content and existing memory are in the prompt: whole files while memory is small, otherwise just their paths. Don't read or list what you were given; read individual files only when you have just the path and they look relevant.
- Treat the whole transcript as one interaction: retain useful new information and answer any questions it contains.
- Determine which information has future value and is useful to retain.
- Search existing memory when previous context may help interpret the capture or avoid duplication.
- For questions, search and read enough existing memory to give a grounded answer. Do not include file paths or a Sources section in the response; the harness tracks provenance separately.
- Create useful derived memories with write_memory.
- Create multiple memories when a capture contains meaningfully separate information.
- Use /tasks for actionable commitments, /events for time-associated information, and /memory for other durable context. These are soft categories.
- Use concise, human-readable filenames and Markdown content.
- Avoid redundant or low-value memory.
- Preserve relevant context and uncertainty.
- Do not force every input into a task.
- Do not invent facts the user did not provide.
- Do not create derived memory merely because the user asked a question.
- If new information changes older memory, create a new memory describing the update rather than editing the old file.
- Supply a new unique id and the current offset-aware ISO timestamp for every write.
- End with a concise response for the user. Answer embedded questions directly. If there was no question, briefly acknowledge the capture without listing implementation details or created paths.`;

export const MEMORY_QUERY_SYSTEM_PROMPT = `You answer questions using the user's external memory.

Use list_memory, search_memory, and read_memory to find relevant information. The filesystem is the only source of truth. Do not claim facts that are absent from it. Clearly say when the stored memory is insufficient or contradictory. Give a concise, useful answer. Do not include source citations, file paths, or a Sources section in the answer; the harness tracks provenance separately. You have read-only access and cannot create or alter memory.`;

export type AgentTraceEvent =
  | { type: "tool_start"; tool: string; input: unknown }
  | { type: "tool_end"; tool: string; isError: boolean }
  | { type: "assistant"; text: string };

export type MemoryQueryResult = {
  answer: string;
  accessedPaths: string[];
};

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

// Below this many characters, memory goes into the prompt whole, so questions need no read turns.
export const INLINE_MEMORY_BUDGET = 20_000;

/** Hands the agent what the backend already has, so it spends no model turns fetching it. */
export function capturePrompt(capture: MemoryFile, existingFiles: MemoryFile[], now: Date): { prompt: string; inlined: string[] } {
  const existing = existingFiles.filter((file) => !isInboxPath(file.path));
  const size = existing.reduce((total, file) => total + file.content.length, 0);
  const inlined = size <= INLINE_MEMORY_BUDGET ? existing : [];
  const memory = !existing.length
    ? "Existing memory: none yet"
    : inlined.length
      ? `Existing memory, in full:\n${inlined.map((file) => `<memory path="${file.path}" created_at="${file.frontmatter.created_at}">\n${file.content}\n</memory>`).join("\n")}`
      : `Existing memory files: ${existing.map((file) => file.path).join(", ")}`;
  const prompt = `A new capture was written to ${capture.path}. Its content is below.
Current time: ${now.toISOString()}
${memory}

<capture>
${capture.content}
</capture>

Process it into useful durable memory.`;
  return { prompt, inlined: inlined.map((file) => file.path) };
}

export async function processCapture(options: {
  sandboxRoot: string;
  capturePath: string;
  model?: string;
  onEvent?: (event: AgentTraceEvent) => void;
}): Promise<{ createdPaths: string[]; accessedPaths: string[]; response: string }> {
  const harness = new MemoryHarness(options.sandboxRoot);
  const existing = (await harness.searchMemory({})).files;
  const before = new Set(existing.map((file) => file.path));
  const capture = await harness.readMemory({ path: options.capturePath });
  const accessedPaths = new Set<string>([capture.path]);
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
      if (!event.isError) trackAccessedPaths(event.toolName, event.result?.details, accessedPaths);
    }
  });

  try {
    const { prompt, inlined } = capturePrompt(capture, existing, new Date());
    // Which inlined files the answer drew on is unknowable, so all of them count as consulted.
    for (const path of inlined) accessedPaths.add(path);
    await session.prompt(prompt);
    const last = session.messages.at(-1);
    if (last?.role === "assistant" && last.errorMessage) throw new Error(last.errorMessage);
    const response = session.getLastAssistantText() ?? "";
    options.onEvent?.({ type: "assistant", text: response });
    const after = await harness.searchMemory({});
    return {
      createdPaths: after.files.map((file) => file.path).filter((path) => !before.has(path)),
      accessedPaths: [...accessedPaths].sort(),
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
}): Promise<MemoryQueryResult> {
  if (!options.question.trim()) throw new Error("query cannot be empty");
  const harness = new MemoryHarness(options.sandboxRoot);
  const tools = createMemoryTools(harness).filter((tool) => tool.name !== "write_memory");
  const accessedPaths = new Set<string>();
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
      if (!event.isError) trackAccessedPaths(event.toolName, event.result?.details, accessedPaths);
    }
  });

  try {
    await session.prompt(`Current time: ${new Date().toISOString()}\n\nQuestion: ${options.question}`);
    const last = session.messages.at(-1);
    if (last?.role === "assistant" && last.errorMessage) throw new Error(last.errorMessage);
    const response = session.getLastAssistantText() ?? "";
    options.onEvent?.({ type: "assistant", text: response });
    return { answer: response, accessedPaths: [...accessedPaths].sort() };
  } finally {
    unsubscribe();
    session.dispose();
  }
}

export function trackAccessedPaths(tool: string, details: unknown, paths: Set<string>): void {
  if (tool === "read_memory" && isObject(details) && typeof details.path === "string") {
    paths.add(details.path);
  }
  if ((tool === "search_memory" || tool === "list_memory") && isObject(details) && Array.isArray(details.files)) {
    for (const file of details.files) {
      if (typeof file === "string") paths.add(file);
      else if (isObject(file) && typeof file.path === "string") paths.add(file.path);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
