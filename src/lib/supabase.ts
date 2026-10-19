import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env, TENANTS, type TenantSlug } from "../config.js";

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } };

/**
 * Service-role client. BYPASSES RLS.
 * Only for setup and ingestion. Never use it to answer user questions:
 * doing so would silently disable tenant isolation.
 */
export function adminClient(): SupabaseClient {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for this script");
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, noPersist);
}

const tenantClients = new Map<TenantSlug, SupabaseClient>();

/**
 * Client authenticated as a tenant user. Every query runs with that
 * user's JWT, so Postgres RLS decides what is visible.
 */
export async function tenantClient(slug: TenantSlug): Promise<SupabaseClient> {
  const cached = tenantClients.get(slug);
  if (cached) return cached;

  const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, noPersist);
  const { error } = await client.auth.signInWithPassword({
    email: TENANTS[slug].email,
    password: env.TENANT_PASSWORD,
  });
  if (error) {
    throw new Error(`Login failed for tenant "${slug}": ${error.message}. Did you run "npm run setup"?`);
  }
  tenantClients.set(slug, client);
  return client;
}
