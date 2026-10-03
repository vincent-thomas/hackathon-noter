#!/usr/bin/env bun

import { resolve } from "node:path";
import { captureMemory, queryMemoryWorkflow } from "./workflow";

const USAGE = `Usage:
  bun harness/cli.ts capture "your unstructured thought"
  bun harness/cli.ts query "what should I focus on today?"`;

export type CliRequest =
  | { command: "capture"; text: string }
  | { command: "query"; text: string };

export function parseCliArgs(rawArgs: string[]): CliRequest {
  // Keep accepting --json for compatibility; output is now always JSON.
  const args = rawArgs[0] === "--json" ? rawArgs.slice(1) : rawArgs;
  const [command, ...textParts] = args;
  const text = textParts.join(" ").trim();
  if ((command !== "capture" && command !== "query") || !text) throw new Error(USAGE);
  return { command, text };
}

export async function runCli(request: CliRequest) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required");
  const sandboxRoot = resolve(process.env.MEMORY_ROOT ?? "notes/cli");
  const model = process.env.PI_MODEL;
  if (request.command === "capture") {
    return captureMemory({ sandboxRoot, transcript: request.text, model });
  }
  return queryMemoryWorkflow({ sandboxRoot, question: request.text, model });
}

async function main(): Promise<void> {
  try {
    console.log(JSON.stringify(await runCli(parseCliArgs(process.argv.slice(2)))));
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
