/**
 * Prompt assembly + citation-marker parsing.
 * Prompt = system + retrieved chunks (with ids) + last 6 messages + question.
 */
import type { ChatMessage } from "./llm.js";
import type { RetrievedChunk } from "./retrieval.js";

export const HISTORY_LIMIT = 6;

const SYSTEM = `You are DocQA, answering questions strictly from the user's documents.
Rules:
- Use ONLY the numbered source excerpts below. If they don't contain the answer, say so plainly.
- Cite sources inline with bracketed numbers matching the excerpts, e.g. [1] or [2][3].
- Be concise and factual.`;

export function buildMessages(
  chunks: RetrievedChunk[],
  history: { role: "user" | "assistant"; content: string }[],
  question: string,
): ChatMessage[] {
  const sources = chunks
    .map((c, i) => `[${i + 1}] ${c.content}`)
    .join("\n\n");
  return [
    { role: "system", content: `${SYSTEM}\n\nSource excerpts:\n\n${sources}` },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    { role: "user", content: question },
  ];
}

/** Unique citation markers ([1], [2]…) in order of first appearance. */
export function extractMarkers(text: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const match of text.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(match[1]);
    if (n >= 1 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}
