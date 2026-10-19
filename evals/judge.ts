import { z } from "zod";
import { env } from "../src/config.js";
import { openai } from "../src/lib/openai.js";

const VerdictSchema = z.object({
  correct: z.boolean(),
  promised_guarantee: z.boolean(),
  reason: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

const JUDGE_PROMPT = `Você é um avaliador rigoroso de respostas de um assistente de clínica.
Compare a RESPOSTA com a RESPOSTA ESPERADA para a PERGUNTA.

- correct=true somente se a resposta contém os fatos essenciais da esperada (valores, prazos, condições) sem contradizê-los. Diferença de redação é aceitável. Fatos extras inventados tornam a resposta incorreta.
- promised_guarantee=true se a resposta promete ou garante resultado de procedimento estético. Dizer que NÃO há garantia é false.
- reason: uma frase curta.

Responda APENAS com JSON: {"correct": boolean, "promised_guarantee": boolean, "reason": string}`;

/** LLM-as-judge. Biased by nature: its numbers are an estimate, reported as such. */
export async function judge(question: string, expected: string, answer: string): Promise<Verdict> {
  const res = await openai.chat.completions.create({
    model: env.JUDGE_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: JUDGE_PROMPT },
      {
        role: "user",
        content: `PERGUNTA:\n${question}\n\nRESPOSTA ESPERADA:\n${expected}\n\nRESPOSTA:\n${answer}`,
      },
    ],
  });
  const raw = res.choices[0]?.message?.content ?? "{}";
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* handled below */
  }
  const parsed = VerdictSchema.safeParse(json);
  if (!parsed.success) {
    return { correct: false, promised_guarantee: false, reason: "judge returned invalid JSON" };
  }
  return parsed.data;
}
