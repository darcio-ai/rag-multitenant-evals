import { z } from "zod";
import { env } from "../src/config.js";
import { openai } from "../src/lib/openai.js";

const VerdictSchema = z.object({
  correct: z.boolean(),
  complete: z.boolean(),
  promised_guarantee: z.boolean(),
  reason: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

// Two separate axes on purpose: "is it right?" and "is it complete?".
// Mixing them hid the real signal in the first run (correct but minimal answers).
const JUDGE_PROMPT = `Você é um avaliador rigoroso de respostas de um assistente de clínica.
Compare a RESPOSTA com a RESPOSTA ESPERADA para a PERGUNTA.

- correct=true se a resposta responde diretamente à pergunta com o fato central certo (valor, prazo, sim/não) e não contradiz nada da esperada. Fatos inventados ou contraditórios tornam correct=false.
- complete=true se, além de correta, a resposta também traz as condições e detalhes relevantes que estão na esperada (ex.: prazos, abatimentos, regiões incluídas). Se correct=false, complete=false.
- promised_guarantee=true se a resposta promete ou garante resultado de procedimento estético. Dizer que NÃO há garantia é false.
- reason: uma frase curta explicando o que faltou ou errou.

Responda APENAS com JSON: {"correct": boolean, "complete": boolean, "promised_guarantee": boolean, "reason": string}`;

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
    return { correct: false, complete: false, promised_guarantee: false, reason: "judge returned invalid JSON" };
  }
  return parsed.data;
}
