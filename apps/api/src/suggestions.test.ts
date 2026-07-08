import { describe, it, expect } from "vitest";
import { suggestedQuestions, type SuggestionsDeps, type SampledChunk } from "./suggestions.js";
import { memoryKV } from "./cache.js";

const CHUNKS: SampledChunk[] = [
  { docId: "d1", title: "handbook.md", content: "Vacation is 24 days per year." },
  { docId: "d2", title: "spec.md", content: "The rate limit is 1200 requests per minute." },
];

function deps(overrides: Partial<SuggestionsDeps> = {}): SuggestionsDeps & { calls: number } {
  const d = {
    calls: 0,
    sample: async () => CHUNKS,
    complete: async () => {
      d.calls++;
      return '["How many vacation days per year?","What is the rate limit?","Which TLS versions are accepted?"]';
    },
    kv: memoryKV(),
    ...overrides,
  };
  return d;
}

describe("suggestedQuestions", () => {
  it("returns 3 parsed questions from a JSON reply", async () => {
    const questions = await suggestedQuestions(deps(), "u1");
    expect(questions).toHaveLength(3);
    expect(questions[0]).toBe("How many vacation days per year?");
  });

  it("caches per document set: second call skips the LLM", async () => {
    const d = deps();
    await suggestedQuestions(d, "u1");
    await suggestedQuestions(d, "u1");
    expect(d.calls).toBe(1);
  });

  it("different doc set → cache miss → regenerates", async () => {
    const d = deps();
    await suggestedQuestions(d, "u1");
    d.sample = async () => [CHUNKS[0]!];
    await suggestedQuestions(d, "u1");
    expect(d.calls).toBe(2);
  });

  it("returns [] when the user has no ready documents (no LLM call)", async () => {
    const d = deps({ sample: async () => [] });
    expect(await suggestedQuestions(d, "u1")).toEqual([]);
    expect(d.calls).toBe(0);
  });

  it("falls back to line parsing when the reply is not JSON", async () => {
    const d = deps({
      complete: async () =>
        '1. "How many vacation days do employees get?"\n2. What is the default rate limit?\n3. When are promotion packets due?',
    });
    const questions = await suggestedQuestions(d, "u1");
    expect(questions).toHaveLength(3);
    expect(questions[1]).toContain("rate limit");
  });
});
