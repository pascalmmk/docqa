import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { buildServer } from "../server.js";
import { loadConfig } from "../config.js";
import type {
  ConversationsRepo,
  ConversationRow,
  MessageRow,
} from "../repositories/conversations.js";
import type { Retriever } from "../retrieval.js";
import type { ChatStreamer } from "../llm.js";
import type { RateLimiter } from "../ratelimit.js";

const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "error" });
const USER = "00000000-0000-0000-0000-000000000001";

function memoryConversations() {
  const convos: ConversationRow[] = [];
  const messages: MessageRow[] = [];
  const citations: { message_id: string; chunk_id: string; marker: number }[] = [];
  const repo: ConversationsRepo = {
    async create(userId, title) {
      const row: ConversationRow = {
        id: randomUUID(),
        user_id: userId,
        title: title ?? null,
        created_at: new Date(),
      };
      convos.push(row);
      return row;
    },
    async listByUser(userId) {
      return convos.filter((c) => c.user_id === userId);
    },
    async getById(userId, id) {
      return convos.find((c) => c.user_id === userId && c.id === id) ?? null;
    },
    async setTitle(conversationId, title) {
      const c = convos.find((x) => x.id === conversationId);
      if (c) c.title = title;
    },
    async remove(userId, id) {
      const i = convos.findIndex((c) => c.user_id === userId && c.id === id);
      if (i < 0) return false;
      convos.splice(i, 1);
      return true;
    },
    async messagesWithCitations(conversationId) {
      return messages
        .filter((m) => m.conversation_id === conversationId)
        .map((m) => ({
          ...m,
          citations: citations
            .filter((c) => c.message_id === m.id)
            .map((c) => ({
              marker: c.marker,
              chunkId: c.chunk_id,
              content: "cited chunk content",
              seq: 0,
              documentId: "doc-1",
            })),
        }));
    },
    async recentMessages(conversationId, limit) {
      return messages.filter((m) => m.conversation_id === conversationId).slice(-limit);
    },
    async addMessage(conversationId, role, content) {
      const row: MessageRow = {
        id: randomUUID(),
        conversation_id: conversationId,
        role,
        content,
        created_at: new Date(),
      };
      messages.push(row);
      return row;
    },
    async addCitations(messageId, cs) {
      for (const c of cs) citations.push({ message_id: messageId, chunk_id: c.chunkId, marker: c.marker });
    },
  };
  return { repo, convos, messages, citations };
}

const retriever: Retriever = async () => [
  { id: "chunk-1", documentId: "doc-1", seq: 0, content: "Paris is the capital of France.", score: 1 },
  { id: "chunk-2", documentId: "doc-1", seq: 1, content: "France is in Europe.", score: 0.5 },
];

function tokenStreamer(tokens: string[]): ChatStreamer {
  return {
    async *stream() {
      for (const t of tokens) yield t;
    },
  };
}

const failingStreamer: ChatStreamer = {
  async *stream() {
    throw new Error("LLM down");
  },
};

function makeApp(overrides: Partial<{ chat: ChatStreamer; limiter: RateLimiter }> = {}) {
  const store = memoryConversations();
  const app = buildServer({
    config,
    resolveUser: async () => USER,
    conversations: {
      conversations: store.repo,
      retriever,
      chat: overrides.chat ?? tokenStreamer(["The capital ", "is Paris ", "[1]."]),
      questionLimiter: overrides.limiter ?? { consume: async () => ({ allowed: true }) },
    },
  });
  return { app, store };
}

function sseEvents(payload: string): { type: string; [k: string]: unknown }[] {
  return payload
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)));
}

describe("conversations", () => {
  it("creates and fetches a conversation", async () => {
    const { app } = makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/conversations",
      payload: { title: "test" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const fetched = await app.inject({ method: "GET", url: `/conversations/${id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().messages).toEqual([]);
  });

  it("lists conversations, titles them from the first question, deletes them", async () => {
    const { app } = makeApp();
    const convoId = (
      await app.inject({ method: "POST", url: "/conversations", payload: {} })
    ).json().id;

    await app.inject({
      method: "POST",
      url: `/conversations/${convoId}/messages`,
      payload: { question: "What is the capital of France?" },
    });

    const list = (await app.inject({ method: "GET", url: "/conversations" })).json();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("What is the capital of France?");

    const del = await app.inject({ method: "DELETE", url: `/conversations/${convoId}` });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/conversations" })).json()).toHaveLength(0);
  });

  it("streams sources, tokens, done — and persists message + citations", async () => {
    const { app, store } = makeApp();
    const convoId = (
      await app.inject({ method: "POST", url: "/conversations", payload: {} })
    ).json().id;

    const res = await app.inject({
      method: "POST",
      url: `/conversations/${convoId}/messages`,
      payload: { question: "What is the capital of France?" },
    });

    const events = sseEvents(res.payload);
    expect(events[0]!.type).toBe("sources");
    expect((events[0]!.sources as unknown[]).length).toBe(2);
    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.map((t) => t.text).join("")).toBe("The capital is Paris [1].");
    expect(events.at(-1)!.type).toBe("done");

    // persisted: user question + assistant answer, citation on marker 1 → chunk-1
    expect(store.messages).toHaveLength(2);
    expect(store.messages[1]!.content).toBe("The capital is Paris [1].");
    expect(store.citations).toEqual([
      { message_id: store.messages[1]!.id, chunk_id: "chunk-1", marker: 1 },
    ]);
  });

  it("degrades gracefully when the LLM is down: sources still sent, nothing persisted as answer", async () => {
    const { app, store } = makeApp({ chat: failingStreamer });
    const convoId = (
      await app.inject({ method: "POST", url: "/conversations", payload: {} })
    ).json().id;

    const res = await app.inject({
      method: "POST",
      url: `/conversations/${convoId}/messages`,
      payload: { question: "anything" },
    });

    const events = sseEvents(res.payload);
    expect(events[0]!.type).toBe("sources");
    expect(events.at(-1)!.type).toBe("degraded");
    expect(store.messages).toHaveLength(1); // only the user question
  });

  it("429 with Retry-After when rate limited", async () => {
    const { app } = makeApp({
      limiter: { consume: async () => ({ allowed: false, retryAfterSec: 120 }) },
    });
    const convoId = (
      await app.inject({ method: "POST", url: "/conversations", payload: {} })
    ).json().id;

    const res = await app.inject({
      method: "POST",
      url: `/conversations/${convoId}/messages`,
      payload: { question: "q" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("120");
  });

  it("404 for someone else's conversation, 400 for bad body", async () => {
    const { app } = makeApp();
    const missing = await app.inject({
      method: "POST",
      url: `/conversations/${randomUUID()}/messages`,
      payload: { question: "q" },
    });
    expect(missing.statusCode).toBe(404);

    const convoId = (
      await app.inject({ method: "POST", url: "/conversations", payload: {} })
    ).json().id;
    const bad = await app.inject({
      method: "POST",
      url: `/conversations/${convoId}/messages`,
      payload: { nope: true },
    });
    expect(bad.statusCode).toBe(400);
  });
});
