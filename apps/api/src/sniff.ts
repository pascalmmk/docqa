/**
 * File-type sniffing by content, not extension (design doc §5 Security).
 * We accept exactly two types: PDF and plain text.
 */
export type SniffedType = "pdf" | "text";

export function sniffFileType(buf: Buffer): SniffedType | null {
  if (buf.length === 0) return null;
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";

  // Text heuristic: no NUL bytes and valid UTF-8 in the first 8 KB.
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return "text";
  } catch {
    return null;
  }
}
