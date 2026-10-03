import { z } from "zod";

const CondenseResponseSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })),
});

export type CondenseOptions = {
  apiKey: string;
  model?: "helene-1" | "adeline-1";
  compressionRate?: number;
  fetch?: typeof globalThis.fetch;
};

/** Compress prompt-only context. Persisted memory is never sent back to storage. */
export async function condenseText(text: string, options: CondenseOptions): Promise<string> {
  if (!text.trim()) return text;
  if (options.compressionRate !== undefined && (options.compressionRate < 0 || options.compressionRate > 1)) {
    throw new Error("Condense compressionRate must be between 0 and 1");
  }
  const response = await (options.fetch ?? globalThis.fetch)("https://api.condense.chat/v1/compress", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-condense-auth-token": options.apiKey,
    },
    body: JSON.stringify({
      model: options.model ?? "helene-1",
      ...(options.compressionRate === undefined ? {} : { compression_rate: options.compressionRate }),
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!response.ok) throw new Error(`Condense ${response.status}: ${await response.text()}`);
  const result = CondenseResponseSchema.parse(await response.json());
  const content = result.messages[0]?.content;
  if (content === undefined) throw new Error("Condense returned no compressed message");
  return content;
}
