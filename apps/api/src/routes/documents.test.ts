import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { FileStorage } from "@docqa/storage";
import { buildServer } from "../server.js";
import { loadConfig } from "../config.js";
import type { DocumentsRepo, DocumentRow, IngestEventRow } from "../repositories/documents.js";
import type { IngestQueue } from "../queue.js";

const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "error" });
const USER = "00000000-0000-0000-0000-000000000001";

function memoryRepo(): DocumentsRepo & { rows: DocumentRow[] } {
  const rows: DocumentRow[] = [];
  return {
    rows,
    async findByHash(userId, contentHash) {
      return rows.find((r) => r.user_id === userId && r.content_hash === contentHash) ?? null;
    },
    async insert({ userId, title, byteSize, contentHash }) {
      const row: DocumentRow = {
        id: randomUUID(),
        user_id: userId,
        title,
        byte_size: byteSize,
        content_hash: contentHash,
        status: "queued",
        error: null,
        created_at: new Date(),
      };
      rows.push(row);
      return row;
    },
    async listByUser(userId) {
      return rows.filter((r) => r.user_id === userId);
    },
    async getById(userId, id) {
      const doc = rows.find((r) => r.user_id === userId && r.id === id);
      return doc ? { ...doc, events: [] as IngestEventRow[] } : null;
    },
    async remove(userId, id) {
      const i = rows.findIndex((r) => r.user_id === userId && r.id === id);
      return i >= 0 ? rows.splice(i, 1)[0]! : null;
    },
  };
}

function fakeStorage(saved: string[] = []): FileStorage {
  return {
    async save(key) {
      saved.push(key);
    },
    async get() {
      return Buffer.alloc(0);
    },
    async remove() {},
  };
}

function fakeQueue(enqueued: string[] = []): IngestQueue {
  return {
    async enqueue(id) {
      enqueued.push(id);
    },
    async close() {},
  };
}

function testApp(repo = memoryRepo()) {
  const saved: string[] = [];
  const enqueued: string[] = [];
  const app = buildServer({
    config,
    resolveUser: async () => USER,
    documents: { documents: repo, storage: fakeStorage(saved), queue: fakeQueue(enqueued) },
  });
  return { app, repo, saved, enqueued };
}

function multipartBody(filename: string, content: Buffer) {
  const boundary = "----vitestboundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("documents CRUD", () => {
  let ctx: ReturnType<typeof testApp>;
  beforeEach(() => {
    ctx = testApp();
  });

  it("uploads a text file → 202 queued, stores file, enqueues job", async () => {
    const { body, headers } = multipartBody("notes.txt", Buffer.from("hello docqa"));
    const res = await ctx.app.inject({ method: "POST", url: "/documents", headers, body });
    expect(res.statusCode).toBe(202);
    const doc = res.json();
    expect(doc.status).toBe("queued");
    expect(doc.title).toBe("notes.txt");
    expect(ctx.saved).toHaveLength(1);
    expect(ctx.enqueued).toEqual([doc.id]);
  });

  it("re-uploading identical content → 200 with the same document", async () => {
    const { body, headers } = multipartBody("notes.txt", Buffer.from("same content"));
    const first = await ctx.app.inject({ method: "POST", url: "/documents", headers, body });
    const second = await ctx.app.inject({ method: "POST", url: "/documents", headers, body });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(ctx.enqueued).toHaveLength(1);
  });

  it("rejects unsupported binary → 415", async () => {
    const { body, headers } = multipartBody("img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const res = await ctx.app.inject({ method: "POST", url: "/documents", headers, body });
    expect(res.statusCode).toBe(415);
  });

  it("accepts a PDF by magic bytes", async () => {
    const { body, headers } = multipartBody("doc.pdf", Buffer.from("%PDF-1.7 fake"));
    const res = await ctx.app.inject({ method: "POST", url: "/documents", headers, body });
    expect(res.statusCode).toBe(202);
  });

  it("lists, gets, and deletes documents", async () => {
    const { body, headers } = multipartBody("a.txt", Buffer.from("aaa"));
    const created = (await ctx.app.inject({ method: "POST", url: "/documents", headers, body })).json();

    const list = await ctx.app.inject({ method: "GET", url: "/documents" });
    expect(list.json()).toHaveLength(1);

    const get = await ctx.app.inject({ method: "GET", url: `/documents/${created.id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().events).toEqual([]);

    const del = await ctx.app.inject({ method: "DELETE", url: `/documents/${created.id}` });
    expect(del.statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "GET", url: `/documents/${created.id}` })).statusCode).toBe(404);
  });

  it("429 when upload rate limit exceeded", async () => {
    const app = buildServer({
      config,
      resolveUser: async () => USER,
      documents: {
        documents: memoryRepo(),
        storage: fakeStorage(),
        queue: fakeQueue(),
        uploadLimiter: { consume: async () => ({ allowed: false, retryAfterSec: 900 }) },
      },
    });
    const { body, headers } = multipartBody("a.txt", Buffer.from("aaa"));
    const res = await app.inject({ method: "POST", url: "/documents", headers, body });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("900");
  });

  it("401 when user cannot be resolved", async () => {
    const app = buildServer({
      config,
      resolveUser: async () => null,
      documents: { documents: memoryRepo(), storage: fakeStorage(), queue: fakeQueue() },
    });
    const res = await app.inject({ method: "GET", url: "/documents" });
    expect(res.statusCode).toBe(401);
  });
});
