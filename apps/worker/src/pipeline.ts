import { storageKey, type FileStorage } from "@docqa/storage";
import type { WorkerDb } from "./db.js";
import type { Embedder } from "./embed.js";
import { extractText } from "./extract.js";
import { chunkText, type Chunk } from "./chunk.js";

export interface PipelineDeps {
  db: WorkerDb;
  storage: FileStorage;
  embedder: Embedder;
  log?: (msg: string, detail?: unknown) => void;
  embedBatchSize?: number;
}

/**
 * parse → chunk → embed → store, idempotent and resumable:
 * chunks are upserted by (document_id, seq) in batches, so a retry
 * after a mid-ingest failure resumes from the last stored batch.
 */
export async function ingestDocument(deps: PipelineDeps, documentId: string): Promise<void> {
  const { db, storage, embedder, embedBatchSize = 32 } = deps;
  const log = deps.log ?? (() => {});

  const doc = await db.getDocument(documentId);
  if (!doc) {
    log("document vanished, skipping", { documentId });
    return;
  }

  try {
    await db.setStatus(documentId, "processing");
    await db.addEvent(documentId, "started");

    const raw = await storage.get(storageKey(doc.user_id, doc.content_hash));
    const text = await extractText(raw);
    await db.addEvent(documentId, "extracted", { chars: text.length });

    const chunks = chunkText(text);
    if (chunks.length === 0) throw new Error("no text content extracted");
    await db.addEvent(documentId, "chunked", { chunks: chunks.length });

    // Checkpoint resume: skip chunks already stored by a previous attempt.
    const checkpoint = await db.maxSeq(documentId);
    const remaining = chunks.filter((c) => c.seq > checkpoint);
    if (checkpoint >= 0) {
      await db.addEvent(documentId, "resumed", { checkpoint, remaining: remaining.length });
    }

    for (let i = 0; i < remaining.length; i += embedBatchSize) {
      const batch: Chunk[] = remaining.slice(i, i + embedBatchSize);
      const embeddings = await embedder.embed(batch.map((c) => c.content));
      await db.upsertChunks(documentId, batch, embeddings);
    }
    await db.addEvent(documentId, "embedded", { chunks: chunks.length });

    await db.setStatus(documentId, "ready");
    await db.addEvent(documentId, "ready");
    log("ingested", { documentId, chunks: chunks.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.setStatus(documentId, "failed", message).catch(() => {});
    await db.addEvent(documentId, "failed", { error: message }).catch(() => {});
    throw err; // let BullMQ retry / dead-letter
  }
}
