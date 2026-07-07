/**
 * Question-embedding cache (design doc §5): keyed by hash of the
 * normalized question, 24h TTL, never shared across providers/models.
 */
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { QuestionEmbedder } from "./llm.js";

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
}

export function redisKV(redis: Redis): KV {
  return {
    get: (key) => redis.get(key),
    async set(key, value, ttlSec) {
      await redis.set(key, value, "EX", ttlSec);
    },
  };
}

/** In-process fallback for dev without Redis. */
export function memoryKV(): KV {
  const store = new Map<string, { value: string; expires: number }>();
  return {
    async get(key) {
      const hit = store.get(key);
      if (!hit || hit.expires < Date.now()) return null;
      return hit.value;
    },
    async set(key, value, ttlSec) {
      store.set(key, { value, expires: Date.now() + ttlSec * 1000 });
    },
  };
}

const EMBEDDING_TTL_SEC = 24 * 60 * 60;

export function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

export function cachingEmbedder(kv: KV, inner: QuestionEmbedder): QuestionEmbedder {
  return {
    async embed(text) {
      const key = `emb:${createHash("sha256").update(normalizeQuestion(text)).digest("hex")}`;
      const cached = await kv.get(key);
      if (cached) return JSON.parse(cached) as number[];
      const vec = await inner.embed(text);
      await kv.set(key, JSON.stringify(vec), EMBEDDING_TTL_SEC);
      return vec;
    },
  };
}
