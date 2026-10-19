import OpenAI from "openai";
import { env, EMBEDDING_DIMS } from "../config.js";

export const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 3, timeout: 30_000 });

export interface EmbedResult {
  vectors: number[][];
  tokens: number;
}

export async function embed(texts: string[]): Promise<EmbedResult> {
  const res = await openai.embeddings.create({
    model: env.EMBEDDING_MODEL,
    input: texts,
  });
  const vectors = res.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
  for (const v of vectors) {
    if (v.length !== EMBEDDING_DIMS) {
      throw new Error(
        `Embedding has ${v.length} dims, schema expects ${EMBEDDING_DIMS}. Change the model or the migration.`,
      );
    }
  }
  return { vectors, tokens: res.usage.total_tokens };
}

/** pgvector text literal: "[0.1,0.2,...]" */
export function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
