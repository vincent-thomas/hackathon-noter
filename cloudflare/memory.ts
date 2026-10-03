import { parseMarkdown, serializeMarkdown } from "../harness/markdown";
import {
  SearchMemoryInputSchema,
  WriteMemoryInputSchema,
  type MemoryFile,
  type SearchMemoryInput,
  type WriteMemoryInput,
} from "../harness/schemas";

const ROOTS = new Set(["inbox", "tasks", "events", "memory", "briefings"]);

export function safePath(input: string): string {
  if (input === "/") return input;
  if (!input.startsWith("/") || input.includes("\\") || input.includes("\0")) throw new Error(`invalid memory path: ${input}`);
  const parts = input.split("/").filter(Boolean);
  if (!parts.length || !ROOTS.has(parts[0]) || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`invalid memory path: ${input}`);
  }
  if (parts.length > 1 && !input.endsWith(".md")) throw new Error(`memory files must use .md: ${input}`);
  return `/${parts.join("/")}`;
}

export class WorkerMemory {
  constructor(readonly bucket: R2Bucket, readonly userId: string) {}

  private key(path: string): string {
    const safe = safePath(path);
    if (safe === "/") throw new Error("a memory file path is required");
    return `users/${this.userId}${safe}`;
  }

  async read(path: string): Promise<MemoryFile> {
    path = safePath(path);
    const object = await this.bucket.get(this.key(path));
    if (!object) throw new Error(`memory not found: ${path}`);
    return parseMarkdown(path, await object.text());
  }

  async files(): Promise<MemoryFile[]> {
    const objects: R2Object[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix: `users/${this.userId}/`, cursor });
      objects.push(...page.objects);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const files = await Promise.all(objects
      .filter((object) => object.key.endsWith(".md"))
      .map(async (object) => {
        const path = object.key.slice(`users/${this.userId}`.length);
        return this.read(path);
      }));
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async list(path: string): Promise<{ files: string[] }> {
    const scope = safePath(path).replace(/\.md$/, "");
    return { files: (await this.files()).map((file) => file.path).filter((file) => file === scope || file.startsWith(`${scope}/`)) };
  }

  async search(input: SearchMemoryInput): Promise<{ files: MemoryFile[] }> {
    const query = SearchMemoryInputSchema.parse(input);
    const scope = query.path ? safePath(query.path).replace(/\.md$/, "") : "/";
    const needle = query.contains?.toLocaleLowerCase();
    const files = (await this.files()).filter((file) => {
      if (scope !== "/" && file.path !== scope && !file.path.startsWith(`${scope}/`)) return false;
      if (needle && !file.content.toLocaleLowerCase().includes(needle)) return false;
      return !query.frontmatter || Object.entries(query.frontmatter).every(([key, value]) =>
        (file.frontmatter as Record<string, unknown>)[key] === value);
    });
    return { files };
  }

  async write(input: WriteMemoryInput): Promise<MemoryFile> {
    const parsed = WriteMemoryInputSchema.parse(input);
    const path = safePath(parsed.path);
    if (path.startsWith("/inbox/")) throw new Error("write_memory cannot write to /inbox");
    if (await this.bucket.head(this.key(path))) throw new Error(`memory already exists: ${path}`);
    const created = await this.bucket.put(this.key(path), serializeMarkdown(parsed.frontmatter, parsed.content), {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { id: parsed.frontmatter.id, created_at: parsed.frontmatter.created_at },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (!created) throw new Error(`memory already exists: ${path}`);
    return { path, frontmatter: parsed.frontmatter, content: parsed.content };
  }

  async createInbox(transcript: string, source: "voice" | "text"): Promise<MemoryFile> {
    const id = crypto.randomUUID();
    const created_at = new Date().toISOString();
    const path = `/inbox/${created_at.replaceAll(":", "-")}--${id}.md`;
    const frontmatter = { id, created_at, source } as const;
    await this.bucket.put(this.key(path), serializeMarkdown(frontmatter, transcript), {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { id, created_at, source },
    });
    return { path, frontmatter, content: transcript };
  }
}
