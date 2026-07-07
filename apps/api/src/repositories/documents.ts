import type pg from "pg";

export interface DocumentRow {
  id: string;
  user_id: string;
  title: string;
  byte_size: number;
  content_hash: string;
  status: "queued" | "processing" | "ready" | "failed";
  error: string | null;
  created_at: Date;
}

export interface IngestEventRow {
  stage: string;
  detail: unknown;
  created_at: Date;
}

export interface NewDocument {
  userId: string;
  title: string;
  byteSize: number;
  contentHash: string;
}

export interface DocumentsRepo {
  findByHash(userId: string, contentHash: string): Promise<DocumentRow | null>;
  insert(doc: NewDocument): Promise<DocumentRow>;
  listByUser(userId: string): Promise<DocumentRow[]>;
  getById(userId: string, id: string): Promise<(DocumentRow & { events: IngestEventRow[] }) | null>;
  remove(userId: string, id: string): Promise<DocumentRow | null>;
}

export function pgDocumentsRepo(pool: pg.Pool): DocumentsRepo {
  return {
    async findByHash(userId, contentHash) {
      const { rows } = await pool.query<DocumentRow>(
        `SELECT * FROM documents WHERE user_id = $1 AND content_hash = $2`,
        [userId, contentHash],
      );
      return rows[0] ?? null;
    },

    async insert({ userId, title, byteSize, contentHash }) {
      const { rows } = await pool.query<DocumentRow>(
        `INSERT INTO documents (user_id, title, byte_size, content_hash)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [userId, title, byteSize, contentHash],
      );
      return rows[0]!;
    },

    async listByUser(userId) {
      const { rows } = await pool.query<DocumentRow>(
        `SELECT * FROM documents WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId],
      );
      return rows;
    },

    async getById(userId, id) {
      const { rows } = await pool.query<DocumentRow>(
        `SELECT * FROM documents WHERE user_id = $1 AND id = $2`,
        [userId, id],
      );
      const doc = rows[0];
      if (!doc) return null;
      const { rows: events } = await pool.query<IngestEventRow>(
        `SELECT stage, detail, created_at FROM ingest_events
         WHERE document_id = $1 ORDER BY created_at`,
        [id],
      );
      return { ...doc, events };
    },

    async remove(userId, id) {
      const { rows } = await pool.query<DocumentRow>(
        `DELETE FROM documents WHERE user_id = $1 AND id = $2 RETURNING *`,
        [userId, id],
      );
      return rows[0] ?? null;
    },
  };
}
