/**
 * Hybrid retrieval (design doc §2): pgvector cosine top-20 ∪ Postgres
 * full-text top-20 → reciprocal rank fusion → top 8 chunks.
 * Big quality win for names/codes/exact terms over vector-only.
 */
import type pg from "pg";

export interface RetrievedChunk {
  id: string;
  documentId: string;
  seq: number;
  content: string;
  score: number;
}

/** A retriever the chat route can call without knowing about SQL/embeddings. */
export type Retriever = (userId: string, question: string) => Promise<RetrievedChunk[]>;

/**
 * RRF: score(d) = Σ_lists 1 / (k + rank_d). k=60 is the standard constant.
 * Input lists are ordered best-first; ids may appear in multiple lists.
 */
export function reciprocalRankFusion(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return scores;
}

interface ChunkRow {
  id: string;
  document_id: string;
  seq: number;
  content: string;
}

export interface HybridSearchOptions {
  vectorK?: number;
  ftsK?: number;
  topN?: number;
}

export async function hybridSearch(
  pool: pg.Pool,
  userId: string,
  embedding: number[],
  question: string,
  { vectorK = 20, ftsK = 20, topN = 8 }: HybridSearchOptions = {},
): Promise<RetrievedChunk[]> {
  const vectorLiteral = `[${embedding.join(",")}]`;

  const [vec, fts] = await Promise.all([
    pool.query<ChunkRow>(
      `SELECT c.id, c.document_id, c.seq, c.content
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.user_id = $1 AND d.status = 'ready' AND c.embedding IS NOT NULL
       ORDER BY c.embedding <=> $2::vector
       LIMIT $3`,
      [userId, vectorLiteral, vectorK],
    ),
    pool.query<ChunkRow>(
      `SELECT c.id, c.document_id, c.seq, c.content
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.user_id = $1 AND d.status = 'ready'
         AND c.tsv @@ plainto_tsquery('english', $2)
       ORDER BY ts_rank(c.tsv, plainto_tsquery('english', $2)) DESC
       LIMIT $3`,
      [userId, question, ftsK],
    ),
  ]);

  const byId = new Map<string, ChunkRow>();
  for (const row of [...vec.rows, ...fts.rows]) byId.set(row.id, row);

  const fused = reciprocalRankFusion([vec.rows.map((r) => r.id), fts.rows.map((r) => r.id)]);

  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([id, score]) => {
      const row = byId.get(id)!;
      return { id, documentId: row.document_id, seq: row.seq, content: row.content, score };
    });
}
