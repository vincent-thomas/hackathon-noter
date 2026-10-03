import type { Env } from "./types";
import { WorkerMemory } from "./memory";
import { allInlined, capturePrompt, MEMORY_AGENT_SYSTEM_PROMPT, MEMORY_QUERY_SYSTEM_PROMPT, type Turn } from "../harness/prompts";

const BRIEFING_SYSTEM = `Create a concise morning briefing from the user's external memory. Prioritize commitments, time-sensitive plans, open questions, and context useful today. Synthesize rather than dumping notes. Preserve uncertainty and contradictions. Do not invent dates or facts. Do not include source paths, citations, greetings, or a Sources section. Use short Markdown sections and bullets that scan well in email. If nothing is relevant, say so plainly.`;

const declarations = [
  { name: "read_memory", description: "Read one Markdown memory file by virtual path.", parameters: { type: "OBJECT", properties: { path: { type: "STRING" } }, required: ["path"] } },
  { name: "list_memory", description: "List Markdown files below a virtual directory.", parameters: { type: "OBJECT", properties: { path: { type: "STRING" } }, required: ["path"] } },
  { name: "search_memory", description: "Search by path scope, case-insensitive content, and exact frontmatter.", parameters: { type: "OBJECT", properties: { path: { type: "STRING" }, contains: { type: "STRING" }, frontmatter: { type: "OBJECT" } } } },
  { name: "write_memory", description: "Create a derived Markdown memory. Never writes inbox or overwrites.", parameters: { type: "OBJECT", properties: { path: { type: "STRING" }, content: { type: "STRING" }, frontmatter: { type: "OBJECT", properties: { id: { type: "STRING" }, created_at: { type: "STRING" } }, required: ["id", "created_at"] } }, required: ["path", "content", "frontmatter"] } },
];

type Part = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: unknown };
type Content = { role: "user" | "model"; parts: Part[] };

async function generate(env: Env, body: object): Promise<{ content: Content; parts: Part[] }> {
  const model = env.HARNESS_MODEL || "gemini-3.5-flash-lite";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${model} ${response.status}: ${await response.text()}`);
  const json = await response.json<any>();
  const content = json.candidates?.[0]?.content as Content | undefined;
  if (!content?.parts) throw new Error("Gemini returned no response");
  return { content, parts: content.parts };
}

const READ_ONLY = ["read_memory", "list_memory", "search_memory"];

async function runAgent(env: Env, memory: WorkerMemory, system: string, prompt: string, allowed: string[]) {
  const contents: Content[] = [{ role: "user", parts: [{ text: prompt }] }];
  const accessed = new Set<string>();
  const created: string[] = [];
  const tools = declarations.filter((tool) => allowed.includes(tool.name));

  for (let turn = 0; turn < 12; turn++) {
    const result = await generate(env, {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: tools }],
      generationConfig: { temperature: 0.2 },
    });
    contents.push(result.content);
    const calls = result.parts.flatMap((part) => part.functionCall ? [part.functionCall] : []);
    if (!calls.length) return {
      text: result.parts.map((part) => part.text ?? "").join("").trim(),
      accessedPaths: [...accessed].sort(),
      createdPaths: created,
    };

    const responses: Part[] = [];
    for (const call of calls) {
      let output: unknown;
      try {
        if (call.name === "read_memory") {
          output = await memory.read(String(call.args?.path));
          accessed.add((output as { path: string }).path);
        } else if (call.name === "list_memory") {
          output = await memory.list(String(call.args?.path));
          for (const path of (output as { files: string[] }).files) accessed.add(path);
        } else if (call.name === "search_memory") {
          output = await memory.search(call.args ?? {});
          for (const file of (output as { files: Array<{ path: string }> }).files) accessed.add(file.path);
        } else if (call.name === "write_memory" && allowed.includes("write_memory")) {
          output = await memory.write(call.args as any);
          created.push((output as { path: string }).path);
        } else throw new Error(`unknown tool: ${call.name}`);
      } catch (error) {
        output = { error: error instanceof Error ? error.message : String(error) };
      }
      responses.push({ functionResponse: { name: call.name, response: { output } } });
    }
    contents.push({ role: "user", parts: responses });
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
  const result = await runAgent(env, memory, MEMORY_AGENT_SYSTEM_PROMPT, prompt, allowed);
  const response = result.text || "Captured.";
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
