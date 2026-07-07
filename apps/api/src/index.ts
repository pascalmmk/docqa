import { storageFromEnv } from "@docqa/storage";
import { loadConfig } from "./config.js";
import { buildServer, type ServerDeps } from "./server.js";
import { createPool, checkDb } from "./db/pool.js";
import { devUserResolver } from "./auth.js";
import { pgDocumentsRepo } from "./repositories/documents.js";
import { noopQueue, bullmqQueue, type IngestQueue } from "./queue.js";

const config = loadConfig();
const pool = config.DATABASE_URL ? createPool(config.DATABASE_URL) : null;
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
  };
}

const app = buildServer(deps);
if (!pool) app.log.warn("DATABASE_URL not set — document routes disabled, health only");
if (pool && !config.REDIS_URL) app.log.warn("REDIS_URL not set — ingestion jobs are not enqueued");

// Graceful shutdown: stop accepting connections, drain, close pools.
const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    await queue?.close();
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
