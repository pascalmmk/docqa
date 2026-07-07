/**
 * Ingestion worker stub — Week 2 fills this in:
 * BullMQ consumer: parse (pdf-parse) → chunk (~500 tokens, 15% overlap)
 * → batch-embed → upsert chunks by (document_id, seq) → status ready.
 */
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
log.info("worker stub started — ingestion pipeline lands in week 2");

process.on("SIGTERM", () => {
  log.info("worker shutting down");
  process.exit(0);
});
