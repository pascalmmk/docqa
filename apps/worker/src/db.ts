import pg from "pg";
import type { Chunk } from "./chunk.js";

export interface DocumentInfo {
  id: string;
  user_id: string;
  content_hash: string;
  status: string;
}

export interface WorkerDb {
  getDocument(id: string): Promise<DocumentInfo | null>;
  setStatus(id: string, status: "processing" | "ready" | "failed", error?: string): Promise<void>;
  addEvent(documentId: string, stage: string, detail?: unknown): Promise<void>;
  /** Checkpoint: highest chunk seq already stored (-1 if none). */
  maxSeq(documentId: string): Promise<number>;
  upsertChunks(documentId: string, chunks: Chunk[], embeddings: number[][]): Promise<void>;
  close(): Promise<void>;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export function pgWorkerDb(connectionString: string): WorkerDb {
  const pool = new pg.Pool({ connectionString, max: 5 });
  return {
    async getDocument(id) {
      const { rows } = await pool.query<DocumentInfo>(
        `SELECT id, user_id, content_hash, status FROM documents WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    },

    async setStatus(id, status, error) {
      await pool.query(`UPDATE documents SET status = $2, error = $3 WHERE id = $1`, [
        id,
        status,
        error ?? null,
      ]);
    },

    async addEvent(documentId, stage, detail) {
      await pool.query(
        `INSERT INTO ingest_events (document_id, stage, detail) VALUES ($1, $2, $3)`,
        [documentId, stage, detail === undefined ? null : JSON.stringify(detail)],
      );
    },

    async maxSeq(documentId) {
      const { rows } = await pool.query<{ max: number | null }>(
        `SELECT max(seq) AS max FROM chunks WHERE document_id = $1`,
        [documentId],
      );
      return rows[0]?.max ?? -1;
    },

    async upsertChunks(documentId, chunks, embeddings) {
      if (chunks.length !== embeddings.length) {
        throw new Error("chunks/embeddings length mismatch");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i]!;
          await client.query(
            `INSERT INTO chunks (document_id, seq, content, token_count, embedding)
             VALUES ($1, $2, $3, $4, $5::vector)
             ON CONFLICT (document_id, seq) DO UPDATE
               SET content = EXCLUDED.content,
                   token_count = EXCLUDED.token_count,
                   embedding = EXCLUDED.embedding`,
            [documentId, c.seq, c.content, c.tokenCount, toVectorLiteral(embeddings[i]!)],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}
