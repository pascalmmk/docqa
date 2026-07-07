/**
 * Chunker: ~500 tokens per chunk, 15% overlap, splitting on
 * headings/paragraphs first (design doc §2). Token counts are
 * estimated at ~4 chars/token — good enough for sizing windows;
 * swap in a real tokenizer if eval shows it matters.
 */

export interface Chunk {
  seq: number;
  content: string;
  tokenCount: number;
}

export interface ChunkOptions {
  targetTokens: number;
  overlapRatio: number;
}

const DEFAULTS: ChunkOptions = { targetTokens: 500, overlapRatio: 0.15 };

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Split into blocks on markdown headings and blank lines; hard-split oversized blocks. */
function toBlocks(text: string, maxBlockTokens: number): string[] {
  const rough = text
    .split(/\n(?=#{1,6}\s)|\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const blocks: string[] = [];
  for (const block of rough) {
    if (estimateTokens(block) <= maxBlockTokens) {
      blocks.push(block);
      continue;
    }
    // Oversized block: split by sentences, then by hard windows as last resort.
    let current = "";
    for (const sentence of block.split(/(?<=[.!?])\s+/)) {
      if (current && estimateTokens(current + " " + sentence) > maxBlockTokens) {
        blocks.push(current);
        current = sentence;
      } else {
        current = current ? current + " " + sentence : sentence;
      }
    }
    if (current) {
      const maxChars = maxBlockTokens * 4;
      for (let i = 0; i < current.length; i += maxChars) {
        blocks.push(current.slice(i, i + maxChars));
      }
    }
  }
  return blocks;
}

export function chunkText(text: string, opts: Partial<ChunkOptions> = {}): Chunk[] {
  const { targetTokens, overlapRatio } = { ...DEFAULTS, ...opts };
  const overlapTokens = Math.floor(targetTokens * overlapRatio);
  const blocks = toBlocks(text, targetTokens);

  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    const content = current.join("\n\n");
    chunks.push({ seq: chunks.length, content, tokenCount: estimateTokens(content) });
    // Carry trailing blocks totaling ≤ overlap into the next chunk.
    const carried: string[] = [];
    let carriedTokens = 0;
    for (let i = current.length - 1; i >= 0 && carried.length < current.length; i--) {
      const t = estimateTokens(current[i]!);
      if (carriedTokens + t > overlapTokens) break;
      carried.unshift(current[i]!);
      carriedTokens += t;
    }
    current = carried;
    currentTokens = carriedTokens;
  };

  for (const block of blocks) {
    const blockTokens = estimateTokens(block);
    if (currentTokens > 0 && currentTokens + blockTokens > targetTokens) flush();
    current.push(block);
    currentTokens += blockTokens;
  }
  if (currentTokens > 0 && current.join("\n\n").trim()) flush();

  // Drop overlap-only tail chunk if flush left one behind
  return chunks;
}
