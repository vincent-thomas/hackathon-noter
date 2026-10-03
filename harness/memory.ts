import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { parseMarkdown, serializeMarkdown } from "./markdown";
import { prepareSandbox, resolveSandboxPath } from "./paths";
import {
  ListMemoryInputSchema,
  ReadMemoryInputSchema,
  SearchMemoryInputSchema,
  WriteMemoryInputSchema,
  type MemoryFile,
} from "./schemas";

export class MemoryHarness {
  readonly #sandboxRoot: string;
  #preparedRoot?: Promise<string>;

  constructor(sandboxRoot: string) {
    this.#sandboxRoot = sandboxRoot;
  }

  #root(): Promise<string> {
    return this.#preparedRoot ??= prepareSandbox(this.#sandboxRoot);
  }

  async readMemory(input: unknown): Promise<MemoryFile> {
    const { path } = ReadMemoryInputSchema.parse(input);
    const root = await this.#root();
    const resolved = await resolveSandboxPath(root, path);
    if (extname(resolved.virtualPath) !== ".md") {
      throw new Error(`memory path must name a Markdown file: ${resolved.virtualPath}`);
    }
    const stat = await lstat(resolved.hostPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`memory is not a regular file: ${resolved.virtualPath}`);
    }
    return parseMarkdown(resolved.virtualPath, await readFile(resolved.hostPath, "utf8"));
  }

  async listMemory(input: unknown): Promise<{ files: string[] }> {
    const { path } = ListMemoryInputSchema.parse(input);
    const root = await this.#root();
    const resolved = await resolveSandboxPath(root, path);
    const stat = await lstat(resolved.hostPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`memory path is not a directory: ${resolved.virtualPath}`);
    }
    return { files: await this.#listFiles(root, resolved.hostPath) };
  }

  async searchMemory(input: unknown): Promise<{ files: MemoryFile[] }> {
    const query = SearchMemoryInputSchema.parse(input);
    const root = await this.#root();
    const scope = query.path ?? "/";
    let paths: string[];

    if (scope === "/") {
      const groups = await Promise.all(
        ["/inbox", "/tasks", "/events", "/memory", "/briefings"].map(async (path) =>
          (await this.listMemory({ path })).files,
        ),
      );
      paths = groups.flat().sort();
    } else {
      const resolved = await resolveSandboxPath(root, scope);
      const stat = await lstat(resolved.hostPath);
      if (stat.isSymbolicLink()) throw new Error(`unsafe sandbox path: ${resolved.virtualPath}`);
      paths = stat.isDirectory()
        ? await this.#listFiles(root, resolved.hostPath)
        : [resolved.virtualPath];
    }

    const needle = query.contains?.toLocaleLowerCase();
    const files: MemoryFile[] = [];
    for (const path of paths) {
      const file = await this.readMemory({ path });
      if (needle !== undefined && !file.content.toLocaleLowerCase().includes(needle)) continue;
      if (
        query.frontmatter &&
        !Object.entries(query.frontmatter).every(
          ([key, value]) => (file.frontmatter as Record<string, unknown>)[key] === value,
        )
      ) continue;
      files.push(file);
    }
    return { files };
  }

  async writeMemory(input: unknown): Promise<MemoryFile> {
    const parsed = WriteMemoryInputSchema.parse(input);
    const root = await this.#root();
    const resolved = await resolveSandboxPath(root, parsed.path, { createParents: true });
    if (resolved.virtualPath === "/inbox" || resolved.virtualPath.startsWith("/inbox/")) {
      throw new Error("write_memory cannot write to /inbox");
    }
    if (extname(resolved.virtualPath) !== ".md") {
      throw new Error(`memory path must end in .md: ${resolved.virtualPath}`);
    }
    // With a conversation in view, the model re-files what it just recorded; an exact copy adds nothing.
    const copy = (await this.searchMemory({})).files.find(
      (file) => file.path !== resolved.virtualPath && !file.path.startsWith("/inbox/") && file.content.trim() === parsed.content.trim(),
    );
    if (copy) throw new Error(`already recorded in ${copy.path}`);

    let handle;
    try {
      handle = await open(
        resolved.hostPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(serializeMarkdown(parsed.frontmatter, parsed.content), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`memory already exists: ${resolved.virtualPath}`);
      }
      throw error;
    } finally {
      await handle?.close();
    }

    return { path: resolved.virtualPath, frontmatter: parsed.frontmatter, content: parsed.content };
  }

  async #listFiles(root: string, directory: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const hostPath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...await this.#listFiles(root, hostPath));
      if (entry.isFile() && extname(entry.name) === ".md") {
        files.push(`/${relative(root, hostPath).split(sep).join("/")}`);
      }
    }
    return files.sort();
  }
}
