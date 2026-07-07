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

export interface MessageWithCitations extends MessageRow {
  citations: { marker: number; chunkId: string }[];
}

export interface ConversationsRepo {
  create(userId: string, title?: string): Promise<ConversationRow>;
  getById(userId: string, id: string): Promise<ConversationRow | null>;
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

    async getById(userId, id) {
      const { rows } = await pool.query<ConversationRow>(
        `SELECT * FROM conversations WHERE user_id = $1 AND id = $2`,
        [userId, id],
      );
      return rows[0] ?? null;
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
      }>(
        `SELECT ct.message_id, ct.chunk_id, ct.marker
         FROM citations ct
         JOIN messages m ON m.id = ct.message_id
         WHERE m.conversation_id = $1`,
        [conversationId],
      );
      const byMessage = new Map<string, { marker: number; chunkId: string }[]>();
      for (const c of citations) {
        const list = byMessage.get(c.message_id) ?? [];
        list.push({ marker: c.marker, chunkId: c.chunk_id });
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
