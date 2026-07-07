import type { FastifyInstance, FastifyReply } from "fastify";
import { askRequestSchema } from "@docqa/shared";
import type { ConversationsRepo } from "../repositories/conversations.js";
import type { Retriever } from "../retrieval.js";
import type { ChatStreamer } from "../llm.js";
import type { RateLimiter } from "../ratelimit.js";
import { buildMessages, extractMarkers, HISTORY_LIMIT } from "../prompt.js";

export interface ConversationsDeps {
  conversations: ConversationsRepo;
  retriever: Retriever;
  chat: ChatStreamer;
  questionLimiter: RateLimiter;
}

function sse(reply: FastifyReply, origin: string | undefined) {
  // We write to the raw socket, bypassing Fastify's reply pipeline —
  // so the CORS plugin can't help here; set the header ourselves.
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": origin ?? "*",
  });
  return {
    send(event: object) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      reply.raw.end();
    },
  };
}

export async function conversationRoutes(app: FastifyInstance, deps: ConversationsDeps) {
  const { conversations, retriever, chat, questionLimiter } = deps;

  app.post<{ Body: { title?: string } | null }>("/conversations", async (req, reply) => {
    const title = req.body?.title;
    const convo = await conversations.create(req.userId, title);
    return reply.status(201).send({
      id: convo.id,
      title: convo.title,
      createdAt: convo.created_at.toISOString(),
    });
  });

  app.get("/conversations", async (req) => {
    const rows = await conversations.listByUser(req.userId);
    return rows.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.created_at.toISOString(),
    }));
  });

  app.delete<{ Params: { id: string } }>("/conversations/:id", async (req, reply) => {
    const removed = await conversations.remove(req.userId, req.params.id);
    if (!removed) return reply.status(404).send({ title: "conversation not found", status: 404 });
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>("/conversations/:id", async (req, reply) => {
    const convo = await conversations.getById(req.userId, req.params.id);
    if (!convo) return reply.status(404).send({ title: "conversation not found", status: 404 });
    const messages = await conversations.messagesWithCitations(convo.id);
    return {
      id: convo.id,
      title: convo.title,
      createdAt: convo.created_at.toISOString(),
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        citations: m.citations,
        createdAt: m.created_at.toISOString(),
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/conversations/:id/messages",
    async (req, reply) => {
      const parsed = askRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ title: "question required (1–2000 chars)", status: 400 });
      }
      const { question } = parsed.data;

      const limit = await questionLimiter.consume(req.userId);
      if (!limit.allowed) {
        return reply
          .status(429)
          .header("retry-after", String(limit.retryAfterSec ?? 60))
          .send({ title: "rate limit exceeded", status: 429 });
      }

      const convo = await conversations.getById(req.userId, req.params.id);
      if (!convo) return reply.status(404).send({ title: "conversation not found", status: 404 });

      // First question becomes the conversation title.
      if (!convo.title) {
        await conversations.setTitle(convo.id, question.slice(0, 80));
      }

      // Gather context BEFORE persisting the new question, so history
      // contains prior turns only.
      const history = await conversations.recentMessages(convo.id, HISTORY_LIMIT);
      const chunks = await retriever(req.userId, question);
      await conversations.addMessage(convo.id, "user", question);

      const stream = sse(reply, req.headers.origin);
      // Sources first, so the client can render citations as tokens arrive —
      // and so retrieval results stay visible even if the LLM is down.
      stream.send({
        type: "sources",
        sources: chunks.map((c, i) => ({
          marker: i + 1,
          chunkId: c.id,
          documentId: c.documentId,
          seq: c.seq,
          preview: c.content.slice(0, 200),
        })),
      });

      let answer = "";
      try {
        const messages = buildMessages(
          chunks,
          history.map((m) => ({ role: m.role, content: m.content })),
          question,
        );
        for await (const token of chat.stream(messages)) {
          answer += token;
          stream.send({ type: "token", text: token });
        }

        const markers = extractMarkers(answer).filter((n) => n <= chunks.length);
        const saved = await conversations.addMessage(convo.id, "assistant", answer);
        await conversations.addCitations(
          saved.id,
          markers.map((n) => ({ chunkId: chunks[n - 1]!.id, marker: n })),
        );
        stream.send({ type: "done", messageId: saved.id, markers });
      } catch (err) {
        req.log.error({ err }, "chat stream failed");
        stream.send({
          type: "degraded",
          message:
            "The language model is unavailable right now. The retrieved sources above are still valid — please retry shortly.",
        });
      } finally {
        stream.end();
      }
    },
  );
}
