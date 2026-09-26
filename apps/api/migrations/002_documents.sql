-- Documents and their embedded chunks for hybrid (vector + full-text) retrieval.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title        text NOT NULL,
  filename     text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   integer NOT NULL,
  content      bytea NOT NULL,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  error        text,
  chunk_count  integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_tenant_time_idx ON documents (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chunks (
  id           bigserial PRIMARY KEY,
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chunk_index  integer NOT NULL,
  content      text NOT NULL,
  -- 768 dims: nomic-embed-text (Ollama), text-embedding-3-small with dimensions=768, and the hash fallback.
  embedding    vector(768) NOT NULL,
  -- 'simple' config: no language-specific stemming, so EN / RU / AR all tokenize consistently.
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS chunks_tenant_idx ON chunks (tenant_id);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
