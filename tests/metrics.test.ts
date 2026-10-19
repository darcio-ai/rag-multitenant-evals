import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLeak, hitRank, normalizeForLeak, summarize, type ItemResult } from "../evals/metrics.js";

test("leak detection survives price reformatting", () => {
  assert.equal(normalizeForLeak("R$ 1.490,00"), "r$ 1490,00");
  assert.deepEqual(detectLeak("Custa R$1490.", ["1.490"], "t1", ["t1"]), ['answer contains "1.490"']);
  assert.deepEqual(detectLeak("Custa R$ 1.290.", ["1.490"], "t1", ["t1"]), []);
});

test("foreign-tenant chunk in retrieval counts as a leak", () => {
  const r = detectLeak("ok", [], "t1", ["t1", "t2"]);
  assert.equal(r.length, 1);
});

test("hitRank is 1-based and null when missing", () => {
  assert.equal(hitRank("b.md", ["a.md", "b.md"]), 2);
  assert.equal(hitRank("c.md", ["a.md"]), null);
  assert.equal(hitRank(null, ["a.md"]), null);
});

function item(over: Partial<ItemResult>): ItemResult {
  return {
    id: "x", tenant: "aurora", type: "answerable", question: "q", answer: "a",
    refused: false, retrievedSources: [], retrievedTenants: [], hitRank: 1,
    correct: true, promisedGuarantee: false, judgeReason: null, leaked: false,
    leakReasons: [], invalidCitations: [], latencyMs: 100, costUsd: 0.001, error: null,
    ...over,
  };
}

test("summary separates answerable and should-refuse items", () => {
  const s = summarize("t", [
    item({}),
    item({ hitRank: 2, correct: false }),
    item({ type: "cross_tenant", hitRank: null, correct: null, refused: true }),
    item({ type: "unanswerable", hitRank: null, correct: null, refused: false, leaked: true }),
    item({ error: "boom" }),
  ]);
  assert.equal(s.items, 5);
  assert.equal(s.errors, 1);
  assert.equal(s.retrievalHitRate, 1);
  assert.equal(s.mrr, 0.75);
  assert.equal(s.answerAccuracy, 0.5);
  assert.equal(s.refusalAccuracy, 0.5);
  assert.equal(s.leaks, 1);
});
