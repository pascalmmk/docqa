import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { MAX_UPLOAD_BYTES } from "@docqa/shared";
import { storageKey, type FileStorage } from "@docqa/storage";
import type { DocumentsRepo, DocumentRow } from "../repositories/documents.js";
import type { IngestQueue } from "../queue.js";
import type { RateLimiter } from "../ratelimit.js";
import { allowAll } from "../ratelimit.js";
import { sniffFileType } from "../sniff.js";

export interface DocumentsDeps {
  documents: DocumentsRepo;
  storage: FileStorage;
  queue: IngestQueue;
  uploadLimiter?: RateLimiter;
}

function toDto(d: DocumentRow) {
  return {
    id: d.id,
    title: d.title,
    byteSize: d.byte_size,
    status: d.status,
    error: d.error,
    createdAt: d.created_at.toISOString(),
  };
}

export async function documentRoutes(app: FastifyInstance, deps: DocumentsDeps) {
  const { documents, storage, queue } = deps;
  const uploadLimiter = deps.uploadLimiter ?? allowAll();

  app.post("/documents", async (req, reply) => {
    const limit = await uploadLimiter.consume(req.userId);
    if (!limit.allowed) {
      return reply
        .status(429)
        .header("retry-after", String(limit.retryAfterSec ?? 3600))
        .send({ title: "upload rate limit exceeded", status: 429 });
    }

    const file = await req.file();
    if (!file) {
      return reply.status(400).send({ title: "multipart file field required", status: 400 });
    }
    const buf = await file.toBuffer(); // throws if over multipart limit

    const type = sniffFileType(buf);
    if (!type) {
      return reply
        .status(415)
        .send({ title: "unsupported file type: only PDF and plain text", status: 415 });
    }

    const contentHash = createHash("sha256").update(buf).digest("hex");
    const userId = req.userId;

    // Idempotency: same content re-uploaded → return the existing document.
    const existing = await documents.findByHash(userId, contentHash);
    if (existing) {
      return reply.status(200).send(toDto(existing));
    }

    const title = file.filename || "untitled";
    await storage.save(storageKey(userId, contentHash), buf);
    const doc = await documents.insert({
      userId,
      title,
      byteSize: buf.length,
      contentHash,
    });
    await queue.enqueue(doc.id);

    return reply.status(202).send(toDto(doc));
  });

  app.get("/documents", async (req) => {
    const rows = await documents.listByUser(req.userId);
    return rows.map(toDto);
  });

  app.get<{ Params: { id: string } }>("/documents/:id", async (req, reply) => {
    const doc = await documents.getById(req.userId, req.params.id);
    if (!doc) return reply.status(404).send({ title: "document not found", status: 404 });
    return {
      ...toDto(doc),
      events: doc.events.map((e) => ({
        stage: e.stage,
        detail: e.detail,
        createdAt: e.created_at.toISOString(),
      })),
    };
  });

  app.delete<{ Params: { id: string } }>("/documents/:id", async (req, reply) => {
    const doc = await documents.remove(req.userId, req.params.id);
    if (!doc) return reply.status(404).send({ title: "document not found", status: 404 });
    // Chunks cascade in Postgres; raw file removal is best-effort.
    await storage.remove(storageKey(req.userId, doc.content_hash)).catch(() => {});
    return reply.status(204).send();
  });
}

export { MAX_UPLOAD_BYTES };
