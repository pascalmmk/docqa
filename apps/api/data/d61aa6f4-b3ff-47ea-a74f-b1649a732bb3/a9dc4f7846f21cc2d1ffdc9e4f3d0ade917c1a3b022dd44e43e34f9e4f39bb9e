# DocQA

RAG-based document Q&A service: upload documents, ask questions, get streamed answers with citations. Full design in [`docqa_design.md.pdf`](./docqa_design.md.pdf).

## Layout

```
apps/api      Fastify API service (Fly.io) — auth, uploads, SSE chat
apps/worker   Ingestion worker — parse → chunk → embed → store (week 2)
apps/web      Next.js frontend (Vercel)
packages/shared  Shared types + zod schemas
```

## Getting started

```sh
pnpm install
cp .env.example .env        # fill in DATABASE_URL etc.
pnpm migrate                # apply SQL migrations
pnpm --filter @docqa/api dev
```

Checks: `pnpm typecheck` · `pnpm test`

## Deploy

- API: `cd apps/api && fly launch --no-deploy`, set secrets, `fly deploy` (Dockerfile builds from repo root)
- Web: import repo in Vercel, root directory `apps/web`
- DB: Neon (enable pgvector) · Redis: Upstash

## Status

Week 1 walking skeleton: health endpoints, schema + migrations, CI. Next: uploads + documents CRUD, GitHub OAuth.
