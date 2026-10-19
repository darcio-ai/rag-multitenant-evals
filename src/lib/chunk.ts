export interface Chunk {
  index: number;
  content: string;
}

/**
 * Markdown-aware chunker.
 * 1. Splits by "## " sections so a chunk never mixes unrelated topics.
 * 2. Splits long sections by size with overlap, preferring line breaks.
 * 3. Prefixes every chunk with "<doc title> > <section>" (contextual header),
 *    so a chunk like "- Pix: 5% de desconto" still carries what it refers to.
 */
export function chunkMarkdown(markdown: string, size: number, overlap: number): Chunk[] {
  if (overlap >= size) throw new Error("overlap must be smaller than size");

  const text = markdown.replace(/\r\n/g, "\n").trim();
  const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? "Documento").trim();

  const sections: Array<{ heading: string; body: string }> = [];
  const parts = text.split(/^##\s+/m);
  // parts[0] is everything before the first "## " (title + intro)
  const intro = (parts[0] ?? "").replace(/^#\s+.+$/m, "").trim();
  if (intro) sections.push({ heading: "Introdução", body: intro });
  for (const part of parts.slice(1)) {
    const [headingLine = "", ...rest] = part.split("\n");
    const body = rest.join("\n").trim();
    if (body) sections.push({ heading: headingLine.trim(), body });
  }

  const chunks: Chunk[] = [];
  for (const { heading, body } of sections) {
    const header = `${title} > ${heading}\n`;
    for (const piece of splitBySize(body, size - header.length, overlap)) {
      chunks.push({ index: chunks.length, content: header + piece });
    }
  }
  return chunks;
}

function splitBySize(text: string, size: number, overlap: number): string[] {
  const max = Math.max(size, 50);
  if (text.length <= max) return [text];

  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      // Prefer cutting at a line break inside the window
      const lastBreak = text.lastIndexOf("\n", end);
      if (lastBreak > start + max / 2) end = lastBreak;
    }
    out.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out.filter(Boolean);
}
