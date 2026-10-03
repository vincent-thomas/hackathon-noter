import { z } from "zod";

export const MEMORY_DIRECTORIES = [
  "inbox",
  "tasks",
  "events",
  "memory",
  "briefings",
] as const;

export const FrontmatterSchema = z
  .object({
    id: z.string().min(1),
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const InboxFrontmatterSchema = FrontmatterSchema.extend({
  source: z.enum(["voice", "telegram", "text"]),
}).strict();

export const CaptureFrontmatterSchema = FrontmatterSchema.extend({}).strict();

export const ReadMemoryInputSchema = z
  .object({ path: z.string().min(1) })
  .strict();

export const ListMemoryInputSchema = z
  .object({ path: z.string().min(1) })
  .strict();

export const SearchMemoryInputSchema = z
  .object({
    path: z.string().min(1).optional(),
    contains: z.string().optional(),
    frontmatter: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
  })
  .strict();

export const WriteMemoryInputSchema = z
  .object({
    path: z.string().min(1),
    // The model fills blank files when it feels it must call a tool; an empty memory is never worth keeping.
    content: z.string().refine((content) => content.trim() !== "", "memory content cannot be empty"),
    frontmatter: CaptureFrontmatterSchema,
  })
  .strict();

export type Frontmatter = z.infer<typeof FrontmatterSchema>;
export type InboxFrontmatter = z.infer<typeof InboxFrontmatterSchema>;
export type CaptureFrontmatter = z.infer<typeof CaptureFrontmatterSchema>;
export type ReadMemoryInput = z.infer<typeof ReadMemoryInputSchema>;
export type ListMemoryInput = z.infer<typeof ListMemoryInputSchema>;
export type SearchMemoryInput = z.infer<typeof SearchMemoryInputSchema>;
export type WriteMemoryInput = z.infer<typeof WriteMemoryInputSchema>;

export type MemoryFile = {
  path: string;
  frontmatter: InboxFrontmatter | CaptureFrontmatter;
  content: string;
};

