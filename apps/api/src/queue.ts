/**
 * Ingestion queue seam. BullMQ producer when Redis is configured;
 * no-op fallback keeps local dev working without Redis (uploads stay `queued`).
 */
import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { INGEST_QUEUE, type IngestJobData } from "@docqa/shared";

export interface IngestQueue {
  enqueue(documentId: string): Promise<void>;
  close(): Promise<void>;
}

export function noopQueue(log: (msg: string) => void = console.log): IngestQueue {
  return {
    async enqueue(documentId) {
      log(`[queue-stub] no REDIS_URL — document ${documentId} stays queued`);
    },
    async close() {},
  };
}

export function bullmqQueue(redisUrl: string): IngestQueue {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<IngestJobData>(INGEST_QUEUE, {
    // cast: bullmq bundles its own ioredis types; instance is runtime-compatible
    connection: connection as unknown as ConnectionOptions,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: false, // failed set doubles as the dead-letter queue
    },
  });
  return {
    async enqueue(documentId) {
      // jobId = documentId → re-enqueueing the same doc is a no-op while pending
      await queue.add("ingest", { documentId }, { jobId: documentId });
    },
    async close() {
      await queue.close();
      connection.disconnect();
    },
  };
}
