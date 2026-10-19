-- =====================================================================
-- rag-multitenant-evals :: schema
-- Multi-tenant RAG with tenant isolation enforced by Postgres RLS,
-- hybrid retrieval (pgvector + full-text) fused with RRF.
-- =====================================================================

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------
-- Tenant resolution: the tenant comes ONLY from the signed JWT
-- (app_metadata is writable by the service role, never by the end user;
-- user_metadata is user-editable and must NOT be trusted for this).
-- ---------------------------------------------------------------------
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table public.tenants (
  id   uuid primary key,
  slug text not null unique,
  name text not null
);

create table public.documents (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  title      text not null,
  source     text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, source),
  unique (id, tenant_id) -- target for the composite FK below
);

create table public.chunks (
  id          bigint generated always as identity primary key,
  document_id uuid not null,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  chunk_index int  not null,
  content     text not null,
  embedding   extensions.vector(1536) not null,
  fts         tsvector generated always as (to_tsvector('portuguese', content)) stored,
  -- Defense in depth: a chunk can never point to a document of another tenant.
  foreign key (document_id, tenant_id)
    references public.documents (id, tenant_id) on delete cascade
);

-- 1536 dims fits the HNSW limit (2000 for the vector type).
create index chunks_embedding_hnsw on public.chunks
  using hnsw (embedding extensions.vector_cosine_ops);
create index chunks_fts_gin on public.chunks using gin (fts);
create index chunks_tenant_idx on public.chunks (tenant_id);

-- ---------------------------------------------------------------------
-- RLS: read-only for authenticated users, scoped to their tenant.
-- No insert/update/delete policies: only the service role (ingestion)
-- can write.
-- ---------------------------------------------------------------------
alter table public.tenants   enable row level security;
alter table public.documents enable row level security;
alter table public.chunks    enable row level security;

create policy tenant_read_self on public.tenants
  for select to authenticated
  using (id = public.current_tenant_id());

create policy tenant_read_documents on public.documents
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy tenant_read_chunks on public.chunks
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

-- ---------------------------------------------------------------------
-- Hybrid search (Reciprocal Rank Fusion).
-- SECURITY INVOKER: runs with the caller's permissions, so RLS applies.
-- The function takes NO tenant parameter on purpose.
-- ---------------------------------------------------------------------
create or replace function public.hybrid_search(
  query_text      text,
  query_embedding extensions.vector(1536),
  match_count     int     default 5,
  use_keyword     boolean default true,
  rrf_k           int     default 60
)
returns table (
  chunk_id    bigint,
  document_id uuid,
  tenant_id   uuid,
  title       text,
  source      text,
  content     text,
  similarity  float,
  score       float
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with
  -- OR between terms: websearch/plainto default to AND, which makes the
  -- keyword branch return nothing for most natural-language questions.
  q as (
    select to_tsquery(
      'portuguese',
      replace(plainto_tsquery('portuguese', query_text)::text, ' & ', ' | ')
    ) as tsq
  ),
  semantic as (
    select c.id,
           1 - (c.embedding <=> query_embedding) as similarity,
           row_number() over (order by c.embedding <=> query_embedding) as rnk
    from chunks c
    order by c.embedding <=> query_embedding
    limit match_count * 4
  ),
  keyword as (
    select c.id,
           row_number() over (order by ts_rank_cd(c.fts, q.tsq) desc) as rnk
    from chunks c, q
    where use_keyword
      and c.fts @@ q.tsq
    order by ts_rank_cd(c.fts, q.tsq) desc
    limit match_count * 4
  ),
  fused as (
    select coalesce(s.id, k.id) as id,
           s.similarity,
           coalesce(1.0 / (rrf_k + s.rnk), 0)
         + coalesce(1.0 / (rrf_k + k.rnk), 0) as score
    from semantic s
    full outer join keyword k on s.id = k.id
  )
  select c.id, c.document_id, c.tenant_id, d.title, d.source, c.content,
         f.similarity::float, f.score::float
  from fused f
  join chunks c    on c.id = f.id
  join documents d on d.id = c.document_id
  order by f.score desc
  limit match_count;
$$;

grant execute on function public.hybrid_search(text, extensions.vector, int, boolean, int) to authenticated;
grant execute on function public.current_tenant_id() to authenticated;
