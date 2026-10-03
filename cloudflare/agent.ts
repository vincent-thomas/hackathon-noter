import type { Env } from "./types";
import { WorkerMemory } from "./memory";
import { allInlined, capturePrompt, MEMORY_AGENT_SYSTEM_PROMPT, MEMORY_QUERY_SYSTEM_PROMPT, type Turn } from "../harness/prompts";

const BRIEFING_SYSTEM = `Create a concise morning briefing from the user's external memory. Prioritize commitments, time-sensitive plans, open questions, and context useful today. Synthesize rather than dumping notes. Preserve uncertainty and contradictions. Do not invent dates or facts. Do not include source paths, citations, greetings, or a Sources section. Use short Markdown sections and bullets that scan well in email. If nothing is relevant, say so plainly.`;

const declarations = [
  { name: "read_memory", description: "Read one Markdown memory file by virtual path.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "list_memory", description: "List Markdown files below a virtual directory.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "search_memory", description: "Search by path scope, case-insensitive content, and exact frontmatter.", parameters: { type: "object", properties: { path: { type: "string" }, contains: { type: "string" }, frontmatter: { type: "object" } } } },
  { name: "write_memory", description: "Create a derived Markdown memory. Never writes inbox or overwrites.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
];

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

async function generate(env: Env, messages: Message[], tools: typeof declarations): Promise<Message> {
  const model = env.HARNESS_MODEL || "gemini-3.5-flash-lite";
  if (!env.CONDENSE_API_KEY) throw new Error("CONDENSE_API_KEY is required");
  const response = await fetch("https://api.condense.chat/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${env.GEMINI_API_KEY}`,
      "x-condense-auth-token": env.CONDENSE_API_KEY,
      "x-condense-upstream-url": "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    body: JSON.stringify({
      model,
      messages,
      tools: tools.map((tool) => ({ type: "function", function: tool })),
      tool_choice: "auto",
      temperature: 0.2,
    }),
  });
  if (!response.ok) throw new Error(`Condense/${model} ${response.status}: ${await response.text()}`);
  const json = await response.json<any>();
  const message = json.choices?.[0]?.message as Message | undefined;
  if (!message) throw new Error("Condense returned no completion");
  return message;
}

const READ_ONLY = ["read_memory", "list_memory", "search_memory"];

async function runAgent(env: Env, memory: WorkerMemory, system: string, prompt: string, allowed: string[]) {
  const start = performance.now();
  const messages: Message[] = [{ role: "system", content: system }, { role: "user", content: prompt }];
  const accessed = new Set<string>();
  const created: string[] = [];
  const tools = declarations.filter((tool) => allowed.includes(tool.name));

  for (let turn = 0; turn < 12; turn++) {
    const result = await generate(env, messages, tools);
    messages.push(result);
    const calls = result.tool_calls ?? [];
    if (!calls.length) return {
      text: result.content?.trim() ?? "",
      accessedPaths: [...accessed].sort(),
      createdPaths: created,
    };

    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); }
      catch { args = {}; }
      // Each tool call costs a model round trip, so these lines show where the agent spends its time.
      console.log(`harness: ${Math.round(performance.now() - start)} ms, ${call.function.name} ${JSON.stringify(args).slice(0, 120)}`);
      let output: unknown;
      try {
        if (call.function.name === "read_memory") {
          output = await memory.read(String(args.path));
          accessed.add((output as { path: string }).path);
        } else if (call.function.name === "list_memory") {
          output = await memory.list(String(args.path));
          for (const path of (output as { files: string[] }).files) accessed.add(path);
        } else if (call.function.name === "search_memory") {
          output = await memory.search(args);
          for (const file of (output as { files: Array<{ path: string }> }).files) accessed.add(file.path);
        } else if (call.function.name === "write_memory" && allowed.includes("write_memory")) {
          // The id and timestamp are bookkeeping, so they're filled in here; the model misplaced them.
          output = await memory.write({
            path: String(args.path ?? ""),
            content: String(args.content ?? ""),
            frontmatter: { id: crypto.randomUUID(), created_at: new Date().toISOString() },
          });
          created.push((output as { path: string }).path);
        } else throw new Error(`unknown tool: ${call.function.name}`);
      } catch (error) {
        output = { error: error instanceof Error ? error.message : String(error) };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ output }) });
    }
  }
  throw new Error("memory agent exceeded its tool-call limit");
}

const RECENT_TURNS = 6;

async function recentTurns(env: Env, userId: string, conversation: string): Promise<Turn[]> {
  const { results } = await env.DB.prepare(
    "SELECT said, answered FROM conversation_turns WHERE user_id = ? AND conversation = ? ORDER BY id DESC LIMIT ?",
  ).bind(userId, conversation, RECENT_TURNS).all<Turn>();
  return results.reverse();
}

export async function captureMemory(
  env: Env,
  userId: string,
  transcript: string,
  source: "voice" | "telegram" | "text",
  conversation?: string,
) {
  const memory = new WorkerMemory(env.MEMORY, userId);
  const capture = await memory.createInbox(transcript, source);
  const existing = await memory.files();
  const history = conversation ? await recentTurns(env, userId, conversation) : [];
  const { prompt, inlined } = capturePrompt(capture, existing, new Date(), history);
  // With all of memory in the prompt, reading, listing or searching only costs model round trips.
  const allowed = allInlined(existing, inlined) ? ["write_memory"] : [...READ_ONLY, "write_memory"];
  const start = performance.now();
  const result = await runAgent(env, memory, MEMORY_AGENT_SYSTEM_PROMPT, prompt, allowed);
  const response = result.text || "Captured.";
  console.log(`harness: ${Math.round(performance.now() - start)} ms → ${JSON.stringify(result.createdPaths)}`);
  if (conversation) {
    await env.DB.prepare("INSERT INTO conversation_turns (user_id, conversation, said, answered, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, conversation, transcript, response, Date.now()).run();
  }
  return {
    capture: { path: capture.path, id: capture.frontmatter.id },
    createdPaths: result.createdPaths,
    accessedPaths: [...new Set([capture.path, ...inlined, ...result.accessedPaths])].sort(),
    response,
  };
}

export async function queryMemory(env: Env, userId: string, question: string) {
  const result = await runAgent(env, new WorkerMemory(env.MEMORY, userId), MEMORY_QUERY_SYSTEM_PROMPT, `Current time: ${new Date().toISOString()}\n\nQuestion: ${question}`, READ_ONLY);
  return { answer: result.text, accessedPaths: result.accessedPaths };
}

export async function generateMorningBriefing(env: Env, userId: string, localDate: string, timezone: string) {
  const memory = new WorkerMemory(env.MEMORY, userId);
  const path = `/briefings/${localDate}.md`;
  try {
    const existing = await memory.read(path);
    return { path, content: existing.content, accessedPaths: [path], created: false };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("memory not found:")) throw error;
  }

  const files = (await memory.files()).filter((file) => !file.path.startsWith("/inbox/") && !file.path.startsWith("/briefings/"));
  const chars = files.reduce((sum, file) => sum + file.content.length, 0);
  const context = chars <= 30_000
    ? files.map((file) => `<memory path="${file.path}" created_at="${file.frontmatter.created_at}">\n${file.content}\n</memory>`).join("\n") || "none yet"
    : `Memory files: ${files.map((file) => file.path).join(", ")}`;
  const result = await runAgent(env, memory, BRIEFING_SYSTEM, `Local date: ${localDate}\nTimezone: ${timezone}\nCurrent time: ${new Date().toISOString()}\n\n${context}\n\nWrite today's morning briefing.`, READ_ONLY);
  const content = result.text || "Nothing needs your attention this morning.";
  await memory.write({ path, content, frontmatter: { id: crypto.randomUUID(), created_at: new Date().toISOString() } });
  return {
    path,
    content,
    accessedPaths: [...new Set([...(chars <= 30_000 ? files.map((file) => file.path) : []), ...result.accessedPaths])].sort(),
    created: true,
  };
}
