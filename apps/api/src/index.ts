import { Redis } from "ioredis";
import { storageFromEnv } from "@docqa/storage";
import { loadConfig } from "./config.js";
import { buildServer, type ServerDeps } from "./server.js";
import { createPool, checkDb } from "./db/pool.js";
import { devUserResolver } from "./auth.js";
import { pgDocumentsRepo } from "./repositories/documents.js";
import { pgConversationsRepo } from "./repositories/conversations.js";
import { noopQueue, bullmqQueue, type IngestQueue } from "./queue.js";
import { openaiQuestionEmbedder, openaiChatStreamer } from "./llm.js";
import { redisKV, memoryKV, cachingEmbedder } from "./cache.js";
import { allowAll, redisTokenBucket } from "./ratelimit.js";
import { hybridSearch } from "./retrieval.js";

const config = loadConfig();
const pool = config.DATABASE_URL ? createPool(config.DATABASE_URL) : null;
const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }) : null;
let queue: IngestQueue | null = null;

const deps: ServerDeps = {
  config,
  checkReadiness: async () => (pool ? checkDb(pool) : true),
};

if (pool) {
  queue = config.REDIS_URL ? bullmqQueue(config.REDIS_URL) : noopQueue();
  deps.resolveUser = devUserResolver(pool);
  deps.documents = {
    documents: pgDocumentsRepo(pool),
    storage: storageFromEnv(),
    queue,
    // 10 uploads/day (design doc §5)
    uploadLimiter: redis
      ? redisTokenBucket(redis, { capacity: 10, refillPerSec: 10 / 86400, prefix: "rl:upload" })
      : allowAll(),
  };

  if (config.OPENAI_API_KEY) {
    const kv = redis ? redisKV(redis) : memoryKV();
    const embedder = cachingEmbedder(kv, openaiQuestionEmbedder(config.OPENAI_API_KEY));
    deps.conversations = {
      conversations: pgConversationsRepo(pool),
      retriever: async (userId, question) =>
        hybridSearch(pool, userId, await embedder.embed(question), question),
      chat: openaiChatStreamer(config.OPENAI_API_KEY, config.CHAT_MODEL),
      // 20 questions/hour (design doc §5)
      questionLimiter: redis
        ? redisTokenBucket(redis, { capacity: 20, refillPerSec: 20 / 3600, prefix: "rl:question" })
        : allowAll(),
    };
  }
}

const app = buildServer(deps);
if (!pool) app.log.warn("DATABASE_URL not set — document routes disabled, health only");
if (pool && !config.REDIS_URL)
  app.log.warn("REDIS_URL not set — jobs not enqueued, rate limits off, cache in-memory");
if (pool && !config.OPENAI_API_KEY)
  app.log.warn("OPENAI_API_KEY not set — conversation routes disabled");

// Graceful shutdown: stop accepting connections, drain, close pools.
const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    await queue?.close();
    redis?.disconnect();
    await pool?.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    process.exit(1);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

app
  .listen({ port: config.PORT, host: config.HOST })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
