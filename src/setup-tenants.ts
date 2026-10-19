import { env, TENANTS } from "./config.js";
import { adminClient } from "./lib/supabase.js";

// Creates the demo tenants and one user per tenant.
// tenant_id goes into app_metadata (only the service role can write it),
// which is what the RLS policies read from the JWT.
async function main() {
  const db = adminClient();

  const { error: upsertErr } = await db
    .from("tenants")
    .upsert(Object.entries(TENANTS).map(([slug, t]) => ({ id: t.id, slug, name: t.name })));
  if (upsertErr) throw new Error(`tenants upsert: ${upsertErr.message}`);

  const { data: list, error: listErr } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw new Error(`listUsers: ${listErr.message}`);

  for (const [slug, t] of Object.entries(TENANTS)) {
    const existing = list.users.find((u) => u.email === t.email);
    const payload = {
      email: t.email,
      password: env.TENANT_PASSWORD,
      email_confirm: true,
      app_metadata: { tenant_id: t.id },
    };
    const { error } = existing
      ? await db.auth.admin.updateUserById(existing.id, payload)
      : await db.auth.admin.createUser(payload);
    if (error) throw new Error(`user ${t.email}: ${error.message}`);
    console.log(`ok  ${slug.padEnd(8)} ${t.email} -> tenant ${t.id}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
