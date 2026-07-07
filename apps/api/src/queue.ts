/**
 * Ingestion queue seam. BullMQ implementation lands in week 2;
 * until then the no-op queue just logs, so uploads stay `queued`.
 */
export interface IngestQueue {
  enqueue(documentId: string): Promise<void>;
}

export function noopQueue(log: (msg: string) => void = console.log): IngestQueue {
  return {
    async enqueue(documentId) {
      log(`[queue-stub] would enqueue ingestion for document ${documentId}`);
    },
  };
}
