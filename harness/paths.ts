import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { MEMORY_DIRECTORIES } from "./schemas";

const ROOTS = new Set<string>(MEMORY_DIRECTORIES);

export function normalizeVirtualPath(input: string): string {
  if (!input.startsWith("/") || input.includes("\\") || input.includes("\0")) {
    throw new Error(`invalid memory path: ${input}`);
  }

  const parts = input.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`invalid memory path: ${input}`);
  }
  if (!ROOTS.has(parts[0])) throw new Error(`invalid memory path: ${input}`);

  return `/${parts.join("/")}`;
}

export function isInboxPath(path: string): boolean {
  const normalized = normalizeVirtualPath(path);
  return normalized === "/inbox" || normalized.startsWith("/inbox/");
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error("memory path escapes sandbox");
}

export async function prepareSandbox(root: string): Promise<string> {
  const absolute = resolve(root);
  await mkdir(absolute, { recursive: true });
  const canonical = await realpath(absolute);
  for (const directory of MEMORY_DIRECTORIES) {
    await mkdir(resolve(canonical, directory), { recursive: true });
  }
  return canonical;
}

export async function resolveSandboxPath(
  root: string,
  virtualPath: string,
  options: { createParents?: boolean } = {},
): Promise<{ virtualPath: string; hostPath: string }> {
  const normalized = normalizeVirtualPath(virtualPath);
  const hostPath = resolve(root, `.${normalized}`);
  assertContained(root, hostPath);

  const parent = resolve(hostPath, "..");
  const rel = relative(root, parent);
  let cursor = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.createParents) throw error;
      await mkdir(cursor);
      stat = await lstat(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`unsafe sandbox path: ${normalized}`);
    }
  }

  const canonicalParent = await realpath(parent);
  assertContained(root, canonicalParent);
  return { virtualPath: normalized, hostPath };
}
