import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  CaptureFrontmatterSchema,
  InboxFrontmatterSchema,
  type CaptureFrontmatter,
  type InboxFrontmatter,
  type MemoryFile,
} from "./schemas";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export function parseMarkdown(path: string, markdown: string): MemoryFile {
  const match = FRONTMATTER.exec(markdown);
  if (!match) throw new Error(`invalid Markdown frontmatter: ${path}`);

  let raw: unknown;
  try {
    raw = parseYaml(match[1]);
  } catch (error) {
    throw new Error(`invalid YAML frontmatter: ${path}`, { cause: error });
  }

  const schema = path.startsWith("/inbox/")
    ? InboxFrontmatterSchema
    : CaptureFrontmatterSchema;

  return {
    path,
    frontmatter: schema.parse(raw),
    content: match[2]
      .replace(/\r\n/g, "\n")
      .replace(/^\n/, "")
      .replace(/\n$/, ""),
  };
}

export function serializeMarkdown(
  frontmatter: InboxFrontmatter | CaptureFrontmatter,
  content: string,
): string {
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${content.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "")}\n`;
}
