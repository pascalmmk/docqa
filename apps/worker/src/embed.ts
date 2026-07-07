import { EMBEDDING_MODEL, EMBEDDING_DIM } from "@docqa/shared";

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * OpenAI embeddings via plain fetch — batched, with basic 429/5xx retry.
 */
export function openaiEmbedder(
  apiKey: string,
  { model = EMBEDDING_MODEL, batchSize = 64, maxRetries = 3 } = {},
): Embedder {
  async function callApi(input: string[], attempt = 1): Promise<number[][]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, input }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxRetries) throw new Error(`embeddings API ${res.status} after ${attempt} attempts`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return callApi(input, attempt + 1);
    }
    if (!res.ok) {
      throw new Error(`embeddings API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    const out = json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
    for (const vec of out) {
      if (vec.length !== EMBEDDING_DIM) {
        throw new Error(`expected ${EMBEDDING_DIM}-dim embedding, got ${vec.length}`);
      }
    }
    return out;
  }

  return {
    async embed(texts) {
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        results.push(...(await callApi(texts.slice(i, i + batchSize))));
      }
      return results;
    },
  };
}
