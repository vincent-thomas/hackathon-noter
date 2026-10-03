import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { serializeMarkdown } from "./markdown";
import { prepareSandbox, resolveSandboxPath } from "./paths";
import { InboxFrontmatterSchema } from "./schemas";

const CreateInboxCaptureSchema = z.object({
  transcript: z.string().trim().min(1),
  source: InboxFrontmatterSchema.shape.source.default("text"),
}).strict();

export type CreateInboxCaptureInput = z.input<typeof CreateInboxCaptureSchema>;

/** Backend-only inbox writer. This capability is never exposed as an agent tool. */
export async function createInboxCapture(
  sandboxRoot: string,
  input: CreateInboxCaptureInput,
): Promise<{ path: string; id: string }> {
  const parsed = CreateInboxCaptureSchema.parse(input);
  const root = await prepareSandbox(sandboxRoot);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replaceAll(":", "-");
  const virtualPath = `/inbox/${timestamp}--${id}.md`;
  const resolved = await resolveSandboxPath(root, virtualPath);
  const markdown = serializeMarkdown(
    { id, created_at: createdAt, source: parsed.source },
    parsed.transcript,
  );

  const handle = await open(
    resolved.hostPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(markdown, "utf8");
  } finally {
    await handle.close();
  }
  return { path: virtualPath, id };
}

