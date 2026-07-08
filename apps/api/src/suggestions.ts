/**
 * Suggested questions: sample chunks from the user's ready documents,
 * ask the LLM for 3 specific questions, cache per document set —
 * the cache key includes a hash of the ready doc ids, so uploading
 * or deleting a document naturally invalidates it.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { ChatCompleter, ChatMessage } from "./llm.js";
import type { KV } from "./cache.js";

export interface SampledChunk {
  docId: string;
  title: string;
  content: string;
}

export type ChunkSampler = (userId: string) => Promise<SampledChunk[]>;

/** First chunk of each of the user's 5 most recently uploaded ready docs. */
export function pgChunkSampler(pool: pg.Pool): ChunkSampler {
  return async (userId) => {
    const { rows } = await pool.query<{ id: string; title: string; content: string }>(
      `SELECT d.id, d.title, c.content
       FROM documents d
       JOIN chunks c ON c.document_id = d.id AND c.seq = 0
       WHERE d.user_id = $1 AND d.status = 'ready'
       ORDER BY d.created_at DESC
       LIMIT 5`,
      [userId],
    );
    return rows.map((r) => ({ docId: r.id, title: r.title, content: r.content }));
  };
}

const SUGGESTIONS_TTL_SEC = 24 * 60 * 60;

function parseQuestions(raw: string): string[] {
  // Preferred: a JSON array. Fallback: line-by-line.
  try {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start >= 0 && end > start) {
      const arr = JSON.parse(raw.slice(start, end + 1)) as unknown;
      if (Array.isArray(arr)) {
        return arr.filter((q): q is string => typeof q === "string").slice(0, 3);
      }
    }
  } catch {
    /* fall through */
  }
  return raw
    .split("\n")
    .map((l) => l.replace(/^[\s\d.\-*"]+|["\s,]+$/g, ""))
    .filter((l) => l.length > 10 && l.includes("?"))
    .slice(0, 3);
}

export interface SuggestionsDeps {
  sample: ChunkSampler;
  complete: ChatCompleter;
  kv: KV;
}

export async function suggestedQuestions(
  deps: SuggestionsDeps,
  userId: string,
): Promise<string[]> {
  const chunks = await deps.sample(userId);
  if (chunks.length === 0) return [];

  const docSetHash = createHash("sha256")
    .update(chunks.map((c) => c.docId).sort().join(","))
    .digest("hex");
  const key = `sugg:${userId}:${docSetHash}`;

  const cached = await deps.kv.get(key);
  if (cached) return JSON.parse(cached) as string[];

  const excerpts = chunks
    .map((c) => `Document "${c.title}":\n${c.content.slice(0, 1200)}`)
    .join("\n\n---\n\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You generate example questions for a document Q&A app. Given excerpts from the user's documents, reply with a JSON array of exactly 3 short, specific questions that these documents can answer. Questions must be answerable from the excerpts, under 12 words each, and cover different documents/topics when possible. Reply with ONLY the JSON array.",
    },
    { role: "user", content: excerpts },
  ];

  const raw = await deps.complete(messages);
  const questions = parseQuestions(raw);
  if (questions.length > 0) {
    await deps.kv.set(key, JSON.stringify(questions), SUGGESTIONS_TTL_SEC);
  }
  return questions;
}
