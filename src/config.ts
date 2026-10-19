import "dotenv/config";
import { z } from "zod";

// Fail fast on missing/invalid config instead of failing mid-run.
const EnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  TENANT_PASSWORD: z.string().min(12),

  OPENAI_API_KEY: z.string().min(20),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  ANSWER_MODEL: z.string().default("gpt-4o-mini"),
  JUDGE_MODEL: z.string().default("gpt-4o-mini"),

  CHUNK_SIZE: z.coerce.number().int().min(100).default(600),
  CHUNK_OVERLAP: z.coerce.number().int().min(0).default(80),
  RETRIEVAL_MODE: z.enum(["hybrid", "vector"]).default("hybrid"),
  TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.25),

  PRICE_EMBED_PER_M: z.coerce.number().default(0.02),
  PRICE_ANSWER_IN_PER_M: z.coerce.number().default(0.15),
  PRICE_ANSWER_OUT_PER_M: z.coerce.number().default(0.6),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

export const EMBEDDING_DIMS = 1536;

// Demo tenants. Fixed UUIDs keep the eval dataset deterministic.
export const TENANTS = {
  aurora: {
    id: "a0000000-0000-4000-8000-000000000001",
    name: "Clínica Aurora",
    email: "aurora@demo.local",
  },
  lumen: {
    id: "b0000000-0000-4000-8000-000000000002",
    name: "Clínica Lumen",
    email: "lumen@demo.local",
  },
} as const;

export type TenantSlug = keyof typeof TENANTS;

export function isTenantSlug(v: string): v is TenantSlug {
  return v in TENANTS;
}
