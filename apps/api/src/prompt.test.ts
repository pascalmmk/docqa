import { describe, it, expect } from "vitest";
import { buildMessages, extractMarkers } from "./prompt.js";

describe("extractMarkers", () => {
  it("extracts unique markers in order of first appearance", () => {
    expect(extractMarkers("Per [2], and also [1]. Again [2].")).toEqual([2, 1]);
  });
  it("returns empty for no markers", () => {
    expect(extractMarkers("no citations here")).toEqual([]);
  });
  it("ignores absurd numbers", () => {
    expect(extractMarkers("[1] [999]")).toEqual([1]); // 3-digit not matched
  });
});

describe("buildMessages", () => {
  it("numbers chunks, includes history and question", () => {
    const messages = buildMessages(
      [
        { id: "c1", documentId: "d", seq: 0, content: "first chunk", score: 1 },
        { id: "c2", documentId: "d", seq: 1, content: "second chunk", score: 0.5 },
      ],
      [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
      "current question",
    );
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("[1] first chunk");
    expect(messages[0]!.content).toContain("[2] second chunk");
    expect(messages).toHaveLength(4);
    expect(messages.at(-1)).toEqual({ role: "user", content: "current question" });
  });
});
