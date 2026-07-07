import { describe, it, expect } from "vitest";
import type { FileStorage } from "@docqa/storage";
import { ingestDocument, type PipelineDeps } from "./pipeline.js";
import type { WorkerDb, DocumentInfo } from "./db.js";
import type { Chunk } from "./chunk.js";
import type { Embedder } from "./embed.js";
import { EMBEDDING_DIM } from "@docqa/shared";

const DOC: DocumentInfo = {
  id: "d1",
  user_id: "u1",
  content_hash: "hash",
  status: "queued",
};

interface FakeDb extends WorkerDb {
  statuses: { status: string; error?: string }[];
  events: { stage: string; detail?: unknown }[];
  stored: { chunks: Chunk[]; embeddings: number[][] }[];
  storedMaxSeq: number;
}

function fakeDb(doc: DocumentInfo | null = DOC, initialMaxSeq = -1): FakeDb {
  const db: FakeDb = {
    statuses: [],
    events: [],
    stored: [],
    storedMaxSeq: initialMaxSeq,
    async getDocument() {
      return doc;
    },
    async setStatus(_id, status, error) {
      db.statuses.push(error ? { status, error } : { status });
    },
    async addEvent(_id, stage, detail) {
      db.events.push({ stage, detail });
    },
    async maxSeq() {
      return db.storedMaxSeq;
    },
    async upsertChunks(_id, chunks, embeddings) {
      db.stored.push({ chunks, embeddings });
      db.storedMaxSeq = Math.max(db.storedMaxSeq, ...chunks.map((c) => c.seq));
    },
    async close() {},
  };
  return db;
}

function fakeStorage(content: string | Buffer): FileStorage {
  return {
    async save() {},
    async get() {
      return Buffer.isBuffer(content) ? content : Buffer.from(content);
    },
    async remove() {},
  };
}

const goodEmbedder: Embedder = {
  async embed(texts) {
    return texts.map(() => new Array(EMBEDDING_DIM).fill(0.1));
  },
};

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    db: fakeDb(),
    storage: fakeStorage("some document text\n\nwith two paragraphs"),
    embedder: goodEmbedder,
    ...overrides,
  };
}

describe("ingestDocument", () => {
  it("happy path: processing → chunks stored → ready, with event trail", async () => {
    const db = fakeDb();
    await ingestDocument(deps({ db }), "d1");

    expect(db.statuses).toEqual([{ status: "processing" }, { status: "ready" }]);
    expect(db.stored.length).toBeGreaterThan(0);
    const stages = db.events.map((e) => e.stage);
    expect(stages).toEqual(["started", "extracted", "chunked", "embedded", "ready"]);
  });

  it("marks failed and rethrows when embedding blows up", async () => {
    const db = fakeDb();
    const badEmbedder: Embedder = {
      async embed() {
        throw new Error("quota exceeded");
      },
    };
    await expect(ingestDocument(deps({ db, embedder: badEmbedder }), "d1")).rejects.toThrow(
      "quota exceeded",
    );
    expect(db.statuses.at(-1)).toEqual({ status: "failed", error: "quota exceeded" });
    expect(db.events.at(-1)?.stage).toBe("failed");
  });

  it("resumes from checkpoint: already-stored chunks are not re-embedded", async () => {
    const longText = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. ` + "words ".repeat(100)).join("\n\n");
    const embedded: string[] = [];
    const countingEmbedder: Embedder = {
      async embed(texts) {
        embedded.push(...texts);
        return texts.map(() => new Array(EMBEDDING_DIM).fill(0.1));
      },
    };

    // First: how many chunks does a fresh run produce?
    const freshDb = fakeDb();
    await ingestDocument(
      deps({ db: freshDb, storage: fakeStorage(longText), embedder: goodEmbedder }),
      "d1",
    );
    const total = freshDb.stored.flatMap((s) => s.chunks).length;
    expect(total).toBeGreaterThan(2);

    // Now: resume with the first 2 chunks already stored.
    const resumeDb = fakeDb(DOC, 1);
    await ingestDocument(
      deps({ db: resumeDb, storage: fakeStorage(longText), embedder: countingEmbedder }),
      "d1",
    );
    expect(embedded.length).toBe(total - 2);
    expect(resumeDb.events.some((e) => e.stage === "resumed")).toBe(true);
  });

  it("fails cleanly on empty extracted text", async () => {
    const db = fakeDb();
    await expect(ingestDocument(deps({ db, storage: fakeStorage("   ") }), "d1")).rejects.toThrow(
      "no text content",
    );
    expect(db.statuses.at(-1)?.status).toBe("failed");
  });

  it("skips silently when document no longer exists", async () => {
    const db = fakeDb(null);
    await ingestDocument(deps({ db }), "gone");
    expect(db.statuses).toHaveLength(0);
  });
});
