import { processCapture, queryMemory, type AgentTraceEvent, type MemoryQueryResult } from "./agent";
import { createInboxCapture } from "./inbox";

export type CaptureMemoryResult = {
  capture: { path: string; id: string };
  createdPaths: string[];
  response: string;
};

/** High-level text capture workflow for backend and script callers. */
export async function captureMemory(options: {
  sandboxRoot: string;
  transcript: string;
  source?: "voice" | "telegram" | "text";
  model?: string;
  onEvent?: (event: AgentTraceEvent) => void;
}): Promise<CaptureMemoryResult> {
  const capture = await createInboxCapture(options.sandboxRoot, {
    transcript: options.transcript,
    source: options.source ?? "text",
  });
  const processed = await processCapture({
    sandboxRoot: options.sandboxRoot,
    capturePath: capture.path,
    model: options.model,
    onEvent: options.onEvent,
  });
  return { capture, ...processed };
}

/** Named high-level query alias for backend and script callers. */
export async function queryMemoryWorkflow(options: {
  sandboxRoot: string;
  question: string;
  model?: string;
  onEvent?: (event: AgentTraceEvent) => void;
}): Promise<MemoryQueryResult> {
  return queryMemory(options);
}

