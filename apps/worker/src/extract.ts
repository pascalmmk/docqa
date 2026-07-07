/**
 * Text extraction. PDF via pdf-parse (imported from lib path to dodge
 * its debug-mode entrypoint bug); anything else is treated as UTF-8 text.
 */
// @ts-expect-error no types for the lib path import
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export type SourceType = "pdf" | "text";

export function detectType(buf: Buffer): SourceType {
  return buf.subarray(0, 5).toString("latin1") === "%PDF-" ? "pdf" : "text";
}

export async function extractText(buf: Buffer): Promise<string> {
  if (detectType(buf) === "pdf") {
    const result = (await pdfParse(buf)) as { text: string };
    return result.text;
  }
  return buf.toString("utf8");
}
