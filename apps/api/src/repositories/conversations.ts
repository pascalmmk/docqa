import type pg from "pg";

export interface ConversationRow {
  id: string;
  user_id: string;
  title: string | null;
  created_at: Date;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: Date;
}

export interface CitationDetail {
  marker: number;
  chunkId: string;
  /** Chunk fields are null if the underlying chunk/document was deleted. */
  content: string | null;
  seq: number | null;
  documentId: string | null;
}

export interface MessageWithCitations extends MessageRow {
  citations: CitationDetail[];
}

export interface ConversationsRepo {
  create(userId: string, title?: string): Promise<ConversationRow>;
  listByUser(userId: string): Promise<ConversationRow[]>;
  getById(userId: string, id: string): Promise<ConversationRow | null>;
  setTitle(conversationId: string, title: string): Promise<void>;
  remove(userId: string, id: string): Promise<boolean>;
  messagesWithCitations(conversationId: string): Promise<MessageWithCitations[]>;
  recentMessages(conversationId: string, limit: number): Promise<MessageRow[]>;
  addMessage(conversationId: string, role: "user" | "assistant", content: string): Promise<MessageRow>;
  addCitations(messageId: string, citations: { chunkId: string; marker: number }[]): Promise<void>;
}

export function pgConversationsRepo(pool: pg.Pool): ConversationsRepo {
  return {
    async create(userId, title) {
      const { rows } = await pool.query<ConversationRow>(
        `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING *`,
        [userId, title ?? null],
      );
      return rows[0]!;
    },

    async listByUser(userId) {
      const { rows } = await pool.query<ConversationRow>(
        `SELECT * FROM conversations WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId],
      );
      return rows;
    },

    async getById(userId, id) {
      const { rows } = await pool.query<ConversationRow>(
        `SELECT * FROM conversations WHERE user_id = $1 AND id = $2`,
        [userId, id],
      );
      return rows[0] ?? null;
    },

    async setTitle(conversationId, title) {
      await pool.query(`UPDATE conversations SET title = $2 WHERE id = $1`, [
        conversationId,
        title,
      ]);
    },

    async remove(userId, id) {
      const { rowCount } = await pool.query(
        `DELETE FROM conversations WHERE user_id = $1 AND id = $2`,
        [userId, id],
      );
      return (rowCount ?? 0) > 0;
    },

    async messagesWithCitations(conversationId) {
      const { rows: messages } = await pool.query<MessageRow>(
        `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at`,
        [conversationId],
      );
      const { rows: citations } = await pool.query<{
        message_id: string;
        chunk_id: string;
        marker: number;
        content: string | null;
        seq: number | null;
        document_id: string | null;
      }>(
        `SELECT ct.message_id, ct.chunk_id, ct.marker,
                ch.content, ch.seq, ch.document_id
         FROM citations ct
         JOIN messages m ON m.id = ct.message_id
         LEFT JOIN chunks ch ON ch.id = ct.chunk_id
         WHERE m.conversation_id = $1`,
        [conversationId],
      );
      const byMessage = new Map<string, CitationDetail[]>();
      for (const c of citations) {
        const list = byMessage.get(c.message_id) ?? [];
        list.push({
          marker: c.marker,
          chunkId: c.chunk_id,
          content: c.content,
          seq: c.seq,
          documentId: c.document_id,
        });
        byMessage.set(c.message_id, list);
      }
      return messages.map((m) => ({
        ...m,
        citations: (byMessage.get(m.id) ?? []).sort((a, b) => a.marker - b.marker),
      }));
    },

    async recentMessages(conversationId, limit) {
      const { rows } = await pool.query<MessageRow>(
        `SELECT * FROM (
           SELECT * FROM messages WHERE conversation_id = $1
           ORDER BY created_at DESC LIMIT $2
         ) sub ORDER BY created_at`,
        [conversationId, limit],
      );
      return rows;
    },

    async addMessage(conversationId, role, content) {
      const { rows } = await pool.query<MessageRow>(
        `INSERT INTO messages (conversation_id, role, content)
         VALUES ($1, $2, $3) RETURNING *`,
        [conversationId, role, content],
      );
      return rows[0]!;
    },

    async addCitations(messageId, citations) {
      for (const c of citations) {
        await pool.query(
          `INSERT INTO citations (message_id, chunk_id, marker)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [messageId, c.chunkId, c.marker],
        );
      }
    },
  };
}
