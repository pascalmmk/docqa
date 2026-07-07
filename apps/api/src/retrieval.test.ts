import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "./retrieval.js";

describe("reciprocalRankFusion", () => {
  it("ranks items appearing in both lists above single-list items", () => {
    const scores = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "d", "a"],
    ]);
    const sorted = [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    // b: rank2 + rank1; a: rank1 + rank3 — both beat c and d
    expect(sorted.slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(scores.get("a")!).toBeGreaterThan(scores.get("c")!);
    expect(scores.get("b")!).toBeGreaterThan(scores.get("d")!);
  });

  it("higher rank in a single list scores higher", () => {
    const scores = reciprocalRankFusion([["x", "y"]]);
    expect(scores.get("x")!).toBeGreaterThan(scores.get("y")!);
  });

  it("handles empty lists", () => {
    expect(reciprocalRankFusion([[], []]).size).toBe(0);
  });
});
