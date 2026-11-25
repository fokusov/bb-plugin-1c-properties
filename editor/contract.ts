import { z } from "zod";

export const editorConfigSchema = z.object({
  interceptChatOpen: z.boolean(),
  gitPath: z.string(),
  gitReadTimeoutSec: z.number().int().min(10).max(3600),
}).strict();

export const editorHostMethod = {
  input: z.object({
    root: z.string().min(1),
    method: z.enum(["GET", "POST"]),
    path: z.string().min(1),
    body: z.string().max(16 * 1024 * 1024),
    config: editorConfigSchema,
  }).strict(),
  output: z.object({
    status: z.number().int(),
    headers: z.record(z.string(), z.string()),
    body: z.string(),
  }).strict(),
};

export const editorAvailabilityMethod = {
  input: z.object({}),
  output: z.object({ available: z.boolean() }),
};

export type EditorConfig = z.infer<typeof editorConfigSchema>;
export type EditorRequest = z.infer<typeof editorHostMethod.input>;
export type EditorResponse = z.infer<typeof editorHostMethod.output>;
