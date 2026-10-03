#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import type { AgentTraceEvent } from "./agent";
import { MemoryHarness } from "./memory";
import { captureMemory, queryMemoryWorkflow } from "./workflow";

const HELP = `Commands:
  write <path> <content>  Create a derived memory file
  read <path>             Read a memory file
  list <directory>        List Markdown files below a directory
  search <text> [path]    Search content (optionally within a directory)
  help                    Show this help
  exit                    Quit

Examples:
  write /tasks/talk-to-erik.md Talk to Erik about deployment tomorrow
  list /tasks
  read /tasks/talk-to-erik.md
  search deployment
  search deployment /tasks`;

const USAGE = `Usage:
  bun run harness
  bun run harness -- capture "your unstructured thought"
  bun run harness -- query "what should I focus on today?"
  bun run harness -- --json query "what should I focus on today?"
  bun run harness -- shell
  bun run harness -- shell list /tasks`;

export type CliIO = {
  write(message: string): void;
};

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && line[index + 1] === quote) token += line[++index];
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) tokens.push(token), token = "";
    } else {
      token += character;
    }
  }
  if (quote) throw new Error("unterminated quote");
  if (token) tokens.push(token);
  return tokens;
}

export async function executeCommand(
  harness: MemoryHarness,
  line: string,
  io: CliIO,
): Promise<"continue" | "exit"> {
  const [command, ...args] = tokenize(line.trim());
  if (!command) return "continue";

  switch (command.toLowerCase()) {
    case "exit":
    case "quit":
      return "exit";
    case "help":
      io.write(HELP);
      return "continue";
    case "list": {
      if (args.length !== 1) throw new Error("usage: list <directory>");
      const result = await harness.listMemory({ path: args[0] });
      io.write(result.files.length ? result.files.join("\n") : "(empty)");
      return "continue";
    }
    case "read": {
      if (args.length !== 1) throw new Error("usage: read <path>");
      const file = await harness.readMemory({ path: args[0] });
      io.write(JSON.stringify(file, null, 2));
      return "continue";
    }
    case "search": {
      if (args.length < 1 || args.length > 2) throw new Error("usage: search <text> [path]");
      const result = await harness.searchMemory({ contains: args[0], path: args[1] });
      io.write(result.files.length ? JSON.stringify(result.files, null, 2) : "(no matches)");
      return "continue";
    }
    case "write": {
      if (args.length < 2) throw new Error("usage: write <path> <content>");
      const [path, ...content] = args;
      const file = await harness.writeMemory({
        path,
        content: content.join(" "),
        frontmatter: {
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
        },
      });
      io.write(`Created ${file.path}`);
      return "continue";
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function main(): Promise<void> {
  const sandboxRoot = resolve(process.env.MEMORY_ROOT ?? "notes/cli");
  const harness = new MemoryHarness(sandboxRoot);
  const io: CliIO = { write: (message) => console.log(message) };
  const rawArgs = process.argv.slice(2);
  const json = rawArgs[0] === "--json";
  const args = json ? rawArgs.slice(1) : rawArgs;

  if (args[0] === "capture") {
    if (args.length < 2) throw new Error(USAGE);
    await captureAndProcess(sandboxRoot, args.slice(1).join(" "), json);
    return;
  }

  if (args[0] === "query") {
    if (args.length < 2) throw new Error(USAGE);
    await query(sandboxRoot, args.slice(1).join(" "), json);
    return;
  }

  if (args.length && args[0] !== "shell") throw new Error(USAGE);
  const shellCommand = args.slice(1);
  if (shellCommand.length) {
    await executeCommand(harness, shellCommand.map((part) => JSON.stringify(part)).join(" "), io);
    return;
  }

  const terminal = createInterface({ input: process.stdin, output: process.stdout });

  if (args[0] !== "shell") {
    console.log("Noter capture → agent → memory\n");
    try {
      const transcript = await terminal.question("What's on your mind? ");
      await captureAndProcess(sandboxRoot, transcript);
    } finally {
      terminal.close();
    }
    return;
  }


  console.log("Noter memory harness");
  console.log(`Sandbox: ${sandboxRoot}`);
  console.log("Type 'help' for commands.\n");

  try {
    while (true) {
      const line = await terminal.question("memory> ");
      try {
        if (await executeCommand(harness, line, io) === "exit") break;
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    // Ctrl-D closes stdin and is a normal way to leave the shell.
    if ((error as NodeJS.ErrnoException).code !== "ERR_USE_AFTER_CLOSE") throw error;
  } finally {
    terminal.close();
  }
}

async function captureAndProcess(sandboxRoot: string, transcript: string, json = false): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required. Add it to .env or export it before running the harness.");
  }
  if (!json) console.log("Agent processing…");

  const result = await captureMemory({
    sandboxRoot,
    transcript,
    model: process.env.PI_MODEL,
    onEvent: json ? undefined : printTrace,
  });

  if (json) return console.log(JSON.stringify(result));
  console.log(`\nCaptured ${result.capture.path}`);
  if (result.createdPaths.length) {
    console.log("\nCreated memory:");
    for (const path of result.createdPaths) console.log(`  ${path}`);
  } else {
    console.log("\nNo derived memory was needed.");
  }
}

async function query(sandboxRoot: string, question: string, json = false): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required. Add it to .env or export it before running the harness.");
  }
  if (!json) console.log("Agent searching memory…");
  const result = await queryMemoryWorkflow({
    sandboxRoot,
    question,
    model: process.env.PI_MODEL,
    onEvent: json ? undefined : printTrace,
  });
  console.log(json ? JSON.stringify(result) : `\n${result.answer}`);
}

function printTrace(event: AgentTraceEvent): void {
  if (event.type === "tool_start") console.log(`  → ${event.tool} ${JSON.stringify(event.input)}`);
  if (event.type === "tool_end" && event.isError) console.log(`  ✗ ${event.tool} failed`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json")) console.log(JSON.stringify({ error: message }));
    else console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
