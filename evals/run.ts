import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { env, isTenantSlug, TENANTS } from "../src/config.js";
import { askRag } from "../src/lib/rag.js";
import { tenantClient } from "../src/lib/supabase.js";
import { judge } from "./judge.js";
import { detectLeak, hitRank, summarize, type EvalItem, type ItemResult, type Summary } from "./metrics.js";

// Usage: npm run eval -- [label]
// Every query runs with the TENANT user's JWT (never the service role),
// so the leak test exercises the real RLS path.
async function main() {
  const label =
    process.argv[2] ?? `${env.RETRIEVAL_MODE}-c${env.CHUNK_SIZE}-k${env.TOP_K}`;

  const raw = await readFile(path.resolve("evals/dataset.jsonl"), "utf8");
  const items: EvalItem[] = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalItem);

  const results: ItemResult[] = [];
  for (const item of items) {
    process.stdout.write(`${item.id.padEnd(4)} ${item.type.padEnd(13)} `);
    results.push(await runItem(item));
    const r = results[results.length - 1]!;
    console.log(
      r.error
        ? `ERROR ${r.error}`
        : `${r.leaked ? "LEAK " : ""}${r.refused ? "refused" : "answered"}${r.correct === null ? "" : r.correct ? " ok" : " WRONG"}`,
    );
  }

  const summary = summarize(label, results);
  await mkdir("results", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(
    path.join("results", `${label}-${stamp}.json`),
    JSON.stringify({ summary, config: publicConfig(), results }, null, 2),
  );
  await appendSummaryRow(summary);

  printSummary(summary);

  // Quality gate: any leak fails the run (usable as a CI check).
  if (summary.leaks > 0) {
    console.error(`\nFAIL: ${summary.leaks} leak(s) detected.`);
    process.exit(2);
  }
}

async function runItem(item: EvalItem): Promise<ItemResult> {
  const base = {
    id: item.id,
    tenant: item.tenant,
    type: item.type,
    question: item.question,
  };
  try {
    if (!isTenantSlug(item.tenant)) throw new Error(`unknown tenant ${item.tenant}`);
    const db = await tenantClient(item.tenant);
    const r = await askRag(db, item.question);

    const retrievedSources = r.retrieved.map((c) => c.source);
    const retrievedTenants = r.retrieved.map((c) => c.tenant_id);
    const leakReasons = detectLeak(r.answer, item.forbidden, TENANTS[item.tenant].id, retrievedTenants);

    // Judge answerable items. For the others, still check for guarantee promises if it answered.
    let correct: boolean | null = null;
    let promisedGuarantee = false;
    let judgeReason: string | null = null;
    if (item.type === "answerable") {
      const v = await judge(item.question, item.expected_answer, r.answer);
      correct = !r.refused && v.correct;
      promisedGuarantee = v.promised_guarantee;
      judgeReason = v.reason;
    }

    return {
      ...base,
      answer: r.answer,
      refused: r.refused,
      retrievedSources,
      retrievedTenants,
      hitRank: hitRank(item.expected_source, retrievedSources),
      correct,
      promisedGuarantee,
      judgeReason,
      leaked: leakReasons.length > 0,
      leakReasons,
      invalidCitations: r.invalidCitations,
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
      error: null,
    };
  } catch (e) {
    return {
      ...base,
      answer: "",
      refused: false,
      retrievedSources: [],
      retrievedTenants: [],
      hitRank: null,
      correct: null,
      promisedGuarantee: false,
      judgeReason: null,
      leaked: false,
      leakReasons: [],
      invalidCitations: [],
      latencyMs: 0,
      costUsd: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function publicConfig() {
  // Never write secrets to results files.
  return {
    embeddingModel: env.EMBEDDING_MODEL,
    answerModel: env.ANSWER_MODEL,
    judgeModel: env.JUDGE_MODEL,
    chunkSize: env.CHUNK_SIZE,
    chunkOverlap: env.CHUNK_OVERLAP,
    retrievalMode: env.RETRIEVAL_MODE,
    topK: env.TOP_K,
    minSimilarity: env.MIN_SIMILARITY,
  };
}

const pct = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);

async function appendSummaryRow(s: Summary) {
  const file = path.join("results", "summary.md");
  const header =
    "| run | hit@k | MRR | acurácia | recusa indevida | recusa correta | vazamentos | promessa de garantia | citação inválida | latência média | US$/1k consultas |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|\n";
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    /* first run */
  }
  const row = `| ${s.label} | ${pct(s.retrievalHitRate)} | ${s.mrr ?? "-"} | ${pct(s.answerAccuracy)} | ${pct(s.falseRefusalRate)} | ${pct(s.refusalAccuracy)} | ${s.leaks} | ${s.guaranteePromises} | ${s.invalidCitations} | ${s.avgLatencyMs} ms | ${s.costPer1kQueriesUsd} |\n`;
  if (!existing) await writeFile(file, header + row);
  else await appendFile(file, row);
}

function printSummary(s: Summary) {
  console.log(`\n=== ${s.label} ===`);
  console.log(`items: ${s.items} (errors: ${s.errors})`);
  console.log(`retrieval hit@k: ${pct(s.retrievalHitRate)} | MRR: ${s.mrr ?? "-"}`);
  console.log(`answer accuracy (judge): ${pct(s.answerAccuracy)} | false refusals: ${pct(s.falseRefusalRate)}`);
  console.log(`correct refusals (unanswerable + cross-tenant): ${pct(s.refusalAccuracy)}`);
  console.log(`LEAKS: ${s.leaks} | guarantee promises: ${s.guaranteePromises} | invalid citations: ${s.invalidCitations}`);
  console.log(`avg latency: ${s.avgLatencyMs} ms | total: US$ ${s.totalCostUsd} | per 1k queries: US$ ${s.costPer1kQueriesUsd}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
