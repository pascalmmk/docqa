/**
 * Eval harness (design doc §5 — "the differentiator").
 *
 *   pnpm eval          → retrieval hit-rate only (cheap: ~33 embeddings, cached fixtures)
 *   pnpm eval --full   → adds answer generation + LLM-as-judge faithfulness
 *
 * Fixtures are ingested idempotently under a dedicated eval user
 * (github_id = -1) using the SAME chunker as the worker.
 * Exits non-zero if retrieval hit-rate < 0.7 → usable as a CI gate.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chunkText } from "@docqa/shared";
import { openaiEmbedBatch, openaiChatStreamer, type ChatMessage } from "../llm.js";
import { hybridSearch, type RetrievedChunk } from "../retrieval.js";
import { buildMessages } from "../prompt.js";
import { QA_PAIRS } from "./qa.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIXTURES = ["aurora-handbook.md", "atlas-spec.md", "ops-runbook.md"];
const HIT_RATE_GATE = 0.7;

const apiKey = process.env.OPENAI_API_KEY;
const dbUrl = process.env.DATABASE_URL;
const full = process.argv.includes("--full");

if (!apiKey || !dbUrl) {
  console.log("eval: skipped (DATABASE_URL and OPENAI_API_KEY required)");
  process.exit(0);
}

async function ensureEvalUser(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (github_id, email) VALUES (-1, 'eval@docqa.local')
     ON CONFLICT (github_id) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
  );
  return rows[0]!.id;
}

async function ingestFixture(pool: pg.Pool, userId: string, name: string): Promise<void> {
  const content = await readFile(join(FIXTURES_DIR, name), "utf8");
  const hash = createHash("sha256").update(content).digest("hex");

  const existing = await pool.query<{ id: string; chunks: string }>(
    `SELECT d.id, count(c.id) AS chunks
     FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
     WHERE d.user_id = $1 AND d.content_hash = $2
     GROUP BY d.id`,
    [userId, hash],
  );
  if (existing.rows[0] && Number(existing.rows[0].chunks) > 0) return; // cached

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO documents (user_id, title, byte_size, content_hash, status)
     VALUES ($1, $2, $3, $4, 'ready')
     ON CONFLICT (user_id, content_hash) DO UPDATE SET status = 'ready'
     RETURNING id`,
    [userId, name, Buffer.byteLength(content), hash],
  );
  const docId = rows[0]!.id;

  const chunks = chunkText(content);
  const embeddings = await openaiEmbedBatch(apiKey!, chunks.map((c) => c.content));
  for (let i = 0; i < chunks.length; i++) {
    await pool.query(
      `INSERT INTO chunks (document_id, seq, content, token_count, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)
       ON CONFLICT (document_id, seq) DO UPDATE
         SET content = EXCLUDED.content, embedding = EXCLUDED.embedding`,
      [docId, chunks[i]!.seq, chunks[i]!.content, chunks[i]!.tokenCount, `[${embeddings[i]!.join(",")}]`],
    );
  }
  console.log(`ingested ${name}: ${chunks.length} chunks`);
}

async function judge(
  question: string,
  chunks: RetrievedChunk[],
  answer: string,
): Promise<{ faithful: boolean; note: string }> {
  const sources = chunks.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You judge whether an answer is fully supported by the given sources. Reply with exactly 'YES' or 'NO: <short reason>'.",
        },
        {
          role: "user",
          content: `Sources:\n${sources}\n\nQuestion: ${question}\n\nAnswer: ${answer}`,
        },
      ] satisfies ChatMessage[],
    }),
  });
  if (!res.ok) throw new Error(`judge API ${res.status}`);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  const verdict = json.choices[0]?.message.content.trim() ?? "NO: empty";
  return { faithful: verdict.startsWith("YES"), note: verdict };
}

async function main() {
  const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
  const userId = await ensureEvalUser(pool);

  for (const f of FIXTURES) await ingestFixture(pool, userId, f);

  // Embed all questions in one batch (mirrors the cached-question path).
  const questionEmbeddings = await openaiEmbedBatch(apiKey!, QA_PAIRS.map((q) => q.question));

  let hits = 0;
  const misses: string[] = [];
  const retrievedByIndex: RetrievedChunk[][] = [];

  for (let i = 0; i < QA_PAIRS.length; i++) {
    const qa = QA_PAIRS[i]!;
    const chunks = await hybridSearch(pool, userId, questionEmbeddings[i]!, qa.question);
    retrievedByIndex.push(chunks);
    const hit = chunks.some((c) => c.content.includes(qa.gold));
    if (hit) hits++;
    else misses.push(`  MISS [${qa.doc}] ${qa.question}`);
  }

  const hitRate = hits / QA_PAIRS.length;
  console.log(`\nRetrieval hit@8: ${hits}/${QA_PAIRS.length} = ${(hitRate * 100).toFixed(1)}%`);
  if (misses.length) console.log(misses.join("\n"));

  if (full) {
    const chat = openaiChatStreamer(apiKey!, process.env.CHAT_MODEL ?? "gpt-4o-mini");
    let faithful = 0;
    for (let i = 0; i < QA_PAIRS.length; i++) {
      const qa = QA_PAIRS[i]!;
      const chunks = retrievedByIndex[i]!;
      let answer = "";
      for await (const token of chat.stream(buildMessages(chunks, [], qa.question))) answer += token;
      const verdict = await judge(qa.question, chunks, answer);
      if (verdict.faithful) faithful++;
      else console.log(`  UNFAITHFUL: ${qa.question}\n    → ${verdict.note}`);
    }
    console.log(`Faithfulness: ${faithful}/${QA_PAIRS.length} = ${((faithful / QA_PAIRS.length) * 100).toFixed(1)}%`);
  }

  await pool.end();

  if (hitRate < HIT_RATE_GATE) {
    console.error(`\nFAIL: hit rate below gate (${HIT_RATE_GATE * 100}%)`);
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
