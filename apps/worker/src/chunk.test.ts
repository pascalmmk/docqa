import { describe, it, expect } from "vitest";
import { chunkText, estimateTokens } from "./chunk.js";

const para = (n: number, len = 400) => `Paragraph ${n}. ` + "lorem ipsum dolor sit amet ".repeat(Math.ceil(len / 27)).slice(0, len);

describe("chunkText", () => {
  it("returns one chunk for short text", () => {
    const chunks = chunkText("Hello world.\n\nSecond paragraph.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.seq).toBe(0);
    expect(chunks[0]!.content).toContain("Hello world.");
  });

  it("returns empty for empty/whitespace input", () => {
    expect(chunkText("")).toHaveLength(0);
    expect(chunkText("  \n\n  ")).toHaveLength(0);
  });

  it("splits long documents into multiple chunks near the target size", () => {
    const text = Array.from({ length: 20 }, (_, i) => para(i)).join("\n\n");
    const chunks = chunkText(text, { targetTokens: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(700); // target + slack for overlap carry
    }
    // seqs are contiguous from 0
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
  });

  it("creates overlap between consecutive chunks", () => {
    const text = Array.from({ length: 20 }, (_, i) => para(i)).join("\n\n");
    const chunks = chunkText(text, { targetTokens: 500, overlapRatio: 0.15 });
    let overlapping = 0;
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1]!.content.slice(-200);
      if (chunks[i]!.content.includes(prevTail.slice(0, 50))) overlapping++;
    }
    expect(overlapping).toBeGreaterThan(0);
  });

  it("hard-splits a single giant block without paragraph breaks", () => {
    const text = "x".repeat(20000); // ~5000 tokens, no whitespace structure
    const chunks = chunkText(text, { targetTokens: 500 });
    expect(chunks.length).toBeGreaterThan(5);
  });

  it("keeps markdown headings at chunk starts when splitting", () => {
    const sections = Array.from({ length: 10 }, (_, i) => `## Section ${i}\n` + para(i, 600));
    const chunks = chunkText(sections.join("\n\n"), { targetTokens: 300 });
    const startsWithHeading = chunks.filter((c) => /^## Section \d+/m.test(c.content));
    expect(startsWithHeading.length).toBeGreaterThan(0);
  });
});

describe("estimateTokens", () => {
  it("estimates ~1 token per 4 chars", () => {
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });
});
