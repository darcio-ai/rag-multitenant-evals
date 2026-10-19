import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { env, isTenantSlug, TENANTS } from "./config.js";
import { chunkMarkdown } from "./lib/chunk.js";
import { embed, toPgVector } from "./lib/openai.js";
import { adminClient } from "./lib/supabase.js";

const CORPUS_DIR = path.resolve("corpus");
const EMBED_BATCH = 64;

// Idempotent: re-running replaces each tenant's documents.
// Re-run after changing CHUNK_SIZE / CHUNK_OVERLAP to compare configs in the eval.
async function main() {
  const db = adminClient();
  let totalChunks = 0;
  let totalTokens = 0;

  for (const slug of await readdir(CORPUS_DIR)) {
    if (!isTenantSlug(slug)) {
      console.warn(`skip corpus/${slug}: not a known tenant`);
      continue;
    }
    const tenantId = TENANTS[slug].id;

    const { error: delErr } = await db.from("documents").delete().eq("tenant_id", tenantId);
    if (delErr) throw new Error(`cleanup ${slug}: ${delErr.message}`);

    const files = (await readdir(path.join(CORPUS_DIR, slug))).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const markdown = await readFile(path.join(CORPUS_DIR, slug, file), "utf8");
      const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file;
      const chunks = chunkMarkdown(markdown, env.CHUNK_SIZE, env.CHUNK_OVERLAP);

      const { data: doc, error: docErr } = await db
        .from("documents")
        .insert({ tenant_id: tenantId, title, source: file })
        .select("id")
        .single();
      if (docErr || !doc) throw new Error(`insert doc ${slug}/${file}: ${docErr?.message}`);

      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const { vectors, tokens } = await embed(batch.map((c) => c.content));
        totalTokens += tokens;

        const rows = batch.map((c, j) => {
          const v = vectors[j];
          if (!v) throw new Error("embedding count mismatch");
          return {
            document_id: doc.id,
            tenant_id: tenantId,
            chunk_index: c.index,
            content: c.content,
            embedding: toPgVector(v),
          };
        });
        const { error: insErr } = await db.from("chunks").insert(rows);
        if (insErr) throw new Error(`insert chunks ${slug}/${file}: ${insErr.message}`);
      }

      totalChunks += chunks.length;
      console.log(`ok  ${slug}/${file}: ${chunks.length} chunks`);
    }
  }

  const cost = (totalTokens / 1e6) * env.PRICE_EMBED_PER_M;
  console.log(
    `\n${totalChunks} chunks | ${totalTokens} embedding tokens | ~US$ ${cost.toFixed(5)} | chunk=${env.CHUNK_SIZE}/${env.CHUNK_OVERLAP}`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
