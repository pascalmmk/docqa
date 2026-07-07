/**
 * LLM clients for the API side: question embedding + streaming chat.
 * Plain fetch against OpenAI; interfaces keep routes provider-agnostic.
 */
import { EMBEDDING_MODEL, EMBEDDING_DIM } from "@docqa/shared";

export interface QuestionEmbedder {
  embed(text: string): Promise<number[]>;
}

export function openaiQuestionEmbedder(apiKey: string, model = EMBEDDING_MODEL): QuestionEmbedder {
  return {
    async embed(text) {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) throw new Error(`embeddings API ${res.status}`);
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      const vec = json.data[0]?.embedding;
      if (!vec || vec.length !== EMBEDDING_DIM) throw new Error("bad embedding response");
      return vec;
    },
  };
}

/** Batch embeddings (used by the eval harness for fixture ingestion). */
export async function openaiEmbedBatch(
  apiKey: string,
  texts: string[],
  model = EMBEDDING_MODEL,
  batchSize = 64,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: texts.slice(i, i + batchSize) }),
    });
    if (!res.ok) throw new Error(`embeddings API ${res.status}`);
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    out.push(...json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return out;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatStreamer {
  stream(messages: ChatMessage[]): AsyncIterable<string>;
}

/** Streams completion tokens from OpenAI chat completions (SSE). */
export function openaiChatStreamer(apiKey: string, model = "gpt-4o-mini"): ChatStreamer {
  return {
    async *stream(messages) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, stream: true, temperature: 0.2 }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`chat API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const data = line.trim();
            if (!data.startsWith("data:")) continue;
            const payload = data.slice(5).trim();
            if (payload === "[DONE]") return;
            try {
              const parsed = JSON.parse(payload) as {
                choices?: { delta?: { content?: string } }[];
              };
              const token = parsed.choices?.[0]?.delta?.content;
              if (token) yield token;
            } catch {
              // partial/keepalive line — ignore
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
