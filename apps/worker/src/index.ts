import { Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { INGEST_QUEUE, type IngestJobData } from "@docqa/shared";
import { storageFromEnv } from "@docqa/storage";
import { loadConfig } from "./config.js";
import { pgWorkerDb } from "./db.js";
import { openaiEmbedder } from "./embed.js";
import { ingestDocument, type PipelineDeps } from "./pipeline.js";

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });

const db = pgWorkerDb(config.DATABASE_URL);
const deps: PipelineDeps = {
  db,
  storage: storageFromEnv(),
  embedder: openaiEmbedder(config.OPENAI_API_KEY),
  log: (msg, detail) => log.info(detail ?? {}, msg),
};

const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker<IngestJobData>(
  INGEST_QUEUE,
  async (job) => {
    log.info({ jobId: job.id, attempt: job.attemptsMade + 1 }, "processing");
    await ingestDocument(deps, job.data.documentId);
  },
  // cast: bullmq bundles its own ioredis types; instance is runtime-compatible
  { connection: connection as unknown as ConnectionOptions, concurrency: config.WORKER_CONCURRENCY },
);

worker.on("completed", (job) => log.info({ jobId: job.id }, "completed"));
worker.on("failed", (job, err) =>
  log.error({ jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, "failed"),
);

log.info("ingestion worker started");

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  try {
    await worker.close(); // waits for in-flight jobs
    connection.disconnect();
    await db.close();
    process.exit(0);
  } catch (err) {
    log.error({ err }, "error during shutdown");
    process.exit(1);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
