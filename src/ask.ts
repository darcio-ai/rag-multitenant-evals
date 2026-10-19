import { isTenantSlug } from "./config.js";
import { askRag } from "./lib/rag.js";
import { tenantClient } from "./lib/supabase.js";

// Usage: npm run ask -- aurora "Quanto custa a toxina botulínica?"
async function main() {
  const [slug, ...rest] = process.argv.slice(2);
  const question = rest.join(" ").trim();
  if (!slug || !isTenantSlug(slug) || !question) {
    console.error('Usage: npm run ask -- <aurora|lumen> "<pergunta>"');
    process.exit(1);
  }

  const db = await tenantClient(slug);
  const r = await askRag(db, question);

  console.log(`\n${r.answer}\n`);
  console.log(`refused=${r.refused}${r.refusalReason ? ` (${r.refusalReason})` : ""}`);
  console.log(`citations=${JSON.stringify(r.citations)}${r.invalidCitations.length ? ` INVALID=${JSON.stringify(r.invalidCitations)}` : ""}`);
  console.log(`latency=${r.latencyMs}ms cost=US$ ${r.costUsd.toFixed(6)}`);
  console.log("retrieved:");
  for (const c of r.retrieved) {
    console.log(`  #${c.chunk_id} ${c.source} sim=${c.similarity?.toFixed(3) ?? "-"} score=${c.score.toFixed(4)}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
