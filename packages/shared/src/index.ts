import { z } from "zod";

export const documentStatusSchema = z.enum(["queued", "processing", "ready", "failed"]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const documentSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  byteSize: z.number().int(),
  status: documentStatusSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type Document = z.infer<typeof documentSchema>;

export const messageRoleSchema = z.enum(["user", "assistant"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const citationSchema = z.object({
  marker: z.number().int(),
  chunkId: z.string().uuid(),
});
export type Citation = z.infer<typeof citationSchema>;

export const askRequestSchema = z.object({
  question: z.string().min(1).max(2000),
});
export type AskRequest = z.infer<typeof askRequestSchema>;

/** Upload limits (design doc §1) */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
