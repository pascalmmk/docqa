-- 0001_init: full schema from design doc §3
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id   bigint UNIQUE NOT NULL,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL,
  byte_size    integer NOT NULL,
  content_hash text NOT NULL, -- idempotent uploads: same file → same document
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, content_hash)
);

CREATE TABLE chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  content     text NOT NULL,
  token_count integer NOT NULL,
  embedding   vector(1536),
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (document_id, seq) -- worker idempotency: upsert by (document_id, seq)
);

CREATE TABLE conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE citations (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chunk_id   uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  marker     integer NOT NULL,
  PRIMARY KEY (message_id, marker)
);

CREATE TABLE ingest_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  stage       text NOT NULL,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Indexes (design doc: HNSW on embedding, GIN on tsv, btree on FKs)
CREATE INDEX chunks_embedding_hnsw ON chunks
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_tsv_gin ON chunks USING gin (tsv);
CREATE INDEX chunks_document_id_idx ON chunks (document_id);
CREATE INDEX documents_user_id_idx ON documents (user_id);
CREATE INDEX conversations_user_id_idx ON conversations (user_id);
CREATE INDEX messages_conversation_id_idx ON messages (conversation_id);
CREATE INDEX ingest_events_document_id_idx ON ingest_events (document_id);
