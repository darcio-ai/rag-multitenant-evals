import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown } from "../src/lib/chunk.js";

const md = `# Tabela X

## Preços

- Item A: R$ 10
- Item B: R$ 20

## Pagamento

- Pix: 5% de desconto
`;

test("one chunk per section, each with a contextual header", () => {
  const chunks = chunkMarkdown(md, 600, 80);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0]!.content.startsWith("Tabela X > Preços\n"));
  assert.ok(chunks[1]!.content.startsWith("Tabela X > Pagamento\n"));
  assert.ok(chunks[1]!.content.includes("Pix: 5%"));
});

test("long sections are split with overlap and keep the header", () => {
  const body = Array.from({ length: 60 }, (_, i) => `- linha ${i} com algum texto`).join("\n");
  const chunks = chunkMarkdown(`# Doc\n\n## Longa\n\n${body}`, 300, 50);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.content.startsWith("Doc > Longa\n"));
    assert.ok(c.content.length <= 300 + 10);
  }
  // indexes are sequential
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
});

test("rejects overlap >= size", () => {
  assert.throws(() => chunkMarkdown(md, 100, 100));
});
