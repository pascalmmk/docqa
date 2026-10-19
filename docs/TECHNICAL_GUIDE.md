# DocQA

A document question-and-answer app for uploading PDFs and text files, asking questions in a chat, and opening the source passages behind an answer.

DocQA combines a Next.js interface, a Fastify API, a background ingestion worker, PostgreSQL with pgvector, and Redis. OpenAI creates document embeddings and generates answers from retrieved excerpts. Documents, conversations, and citations are stored in PostgreSQL; original uploads are stored on disk or in an S3-compatible bucket.

## Run

Use **Node.js 22** and **pnpm 9.15.0**, matching the repository's CI and container setup. The root package declares Node.js 20 or later.

The full application also needs:

- PostgreSQL with the `vector` extension and support for HNSW indexes.
- Redis reachable through a Redis connection URL (`redis://` or `rediss://`). A REST-only Redis endpoint is not sufficient for BullMQ.
- An OpenAI API key with access to the configured chat model and `text-embedding-3-small`.
- A file-storage location accessible to both the API and worker.

There is no checked-in Docker Compose stack. Provision PostgreSQL and Redis separately.

```sh
git clone https://github.com/pascalmmk/docqa.git
cd docqa
corepack enable
pnpm install --frozen-lockfile
```

### Configure the services

Copy `.env.example` to `.env` at the repository root.

PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS or Linux:

```sh
cp .env.example .env
```

Set these values in the root `.env`:

```dotenv
PORT=3001
HOST=0.0.0.0
LOG_LEVEL=info
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE
REDIS_URL=redis://localhost:6379
OPENAI_API_KEY=YOUR_OPENAI_API_KEY
AUTH_SECRET=REPLACE_WITH_A_LONG_RANDOM_SECRET
CHAT_MODEL=gpt-4o-mini
WORKER_CONCURRENCY=2
DATA_DIR=C:/absolute/path/to/docqa/data
```

Replace the placeholders with your values. On macOS or Linux, use an absolute path such as `/absolute/path/to/docqa/data`.

**Use the same absolute `DATA_DIR` for the API and worker when running locally.** The default `./data` is relative to each process's working directory. Workspace commands start these services in different package directories, so the default can make the API save files somewhere the worker cannot read them.

Set a nonempty `AUTH_SECRET`. The code has a development fallback, and the example file contains an empty value; neither is an appropriate shared deployment secret.

For S3-compatible storage, configure the bucket settings described under [Configuration](#configuration) on both services instead.

### Prepare the packages and database

Build the shared workspace packages before running migrations or starting the services:

```sh
pnpm --filter "./packages/*" build
pnpm migrate
pnpm --filter @docqa/api seed
```

The migrations create the vector extension, tables, indexes, and password-login columns. The database account running them must have permission to create the extension, or an administrator must make it available first.

The seed command creates or updates these demo users:

| Username | Password |
| --- | --- |
| `alice` | `demo1234` |
| `bob` | `demo1234` |
| `charlie` | `demo1234` |

These are demonstration accounts, also advertised by the login interface. Running the seed again resets their password hashes to the demo password. The app does not include account registration or password-reset screens.

### Configure the web app

The browser uses `http://localhost:3001` by default. For a different API address, create `apps/web/.env.local`:

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:3001
```

API and worker development scripts explicitly load the root `.env`. Next.js does not automatically load that workspace-root file, so put the public API URL in the web app's environment or `apps/web/.env.local`.

`NEXT_PUBLIC_API_URL` is public browser configuration. Server credentials belong in the API and worker environment.

### Start development

```sh
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in with a seeded account. The API listens on port 3001 by default.

The root command starts workspace development scripts in parallel, including shared-package watchers. Restart affected services after changing their environment configuration.

## Workflow

1. Sign in with a username and password.
2. Upload a PDF, `.txt`, or `.md` file from the document panel.
3. Wait for its status to change from **queued** to **processing** and then **ready**.
4. Type a question or choose a suggested question.
5. Read the answer as it streams into the conversation.
6. Click a numbered citation to inspect its extracted source passage.
7. Reopen a saved conversation or start a new chat.
8. Delete documents or conversations when no longer needed.

Questions search across all ready documents owned by the signed-in user. There is no document picker that restricts a conversation to one selected file.

## Features and controls

### Username and password login

Passwords are hashed with Node.js `scrypt`, using a random salt. Successful login returns a signed token with a default seven-day lifetime.

The token is a custom `<userId>.<expiry>.<signature>` value signed with HMAC-SHA256, not a JWT. The browser stores it in local storage and sends it in the `Authorization: Bearer ...` header.

The example environment file mentions GitHub OAuth, but the implemented flow uses usernames and passwords. Auth.js and GitHub sign-in are not wired into the application.

### Document uploads and deduplication

The upload route accepts one multipart file with a maximum size of **20 MiB** (`20 * 1024 * 1024` bytes). The interface labels this as 20 MB.

The server checks contents rather than trusting extensions:

- A file beginning with `%PDF-` is treated as a PDF.
- Other nonempty files are treated as text when their initial sample contains valid UTF-8 and no NUL bytes.
- Unsupported binary content is rejected.

The text check samples the first 8 KiB; it is not complete encoding validation of a larger file. The browser chooser advertises `.pdf`, `.txt`, and `.md`.

Uploads receive a SHA-256 content hash. Identical content uploaded by the same user returns the existing document instead of storing and queuing another copy. Deduplication is per user. Returning an existing failed document does not automatically retry it.

Original bytes are stored separately from the database under a key derived from the user ID and content hash.

### Background processing

BullMQ queues ingestion so the upload request does not wait for parsing and embedding.

| Status | Meaning |
| --- | --- |
| `queued` | Waiting for processing. |
| `processing` | Extracting text, splitting it, or embedding chunks. |
| `ready` | Processing completed; the document can participate in retrieval. |
| `failed` | An attempt failed; automatic retries may still remain. |

The browser refreshes documents about every 2.5 seconds while any are queued or processing. It displays statuses and exposes failure text, but does not show percentage progress or a full ingestion-event timeline.

The worker records `started`, `extracted`, `chunked`, `resumed`, `embedded`, `ready`, and `failed` events as applicable. The document-detail endpoint exposes this history.

### PDF and text extraction

PDF text is extracted with `pdf-parse`. Text and Markdown files are decoded as UTF-8 and processed as text.

There is no OCR pipeline. A scanned PDF without extractable text can fail with `no text content extracted`. Word documents, images, and website ingestion are not implemented.

### Chunking and embeddings

The shared chunker targets approximately 500 tokens per chunk, estimating one token per four characters. It splits around Markdown headings and blank lines, then uses sentence boundaries or fixed character windows for oversized blocks.

Overlap carries trailing whole blocks into the next chunk, up to the overlap budget. The default ratio is 15%, but actual overlap is not guaranteed to be exactly 15%.

The worker embeds chunks with OpenAI's `text-embedding-3-small`. Each embedding has 1,536 dimensions, matching the database's `vector(1536)` column.

The pipeline processes batches of 32 chunks. Stored sequences act as a checkpoint: a retry re-extracts and re-chunks the file, then skips sequences already saved. This avoids re-embedding completed batches when the document and chunking behavior remain consistent.

### Hybrid document search

Each question is embedded and searched in two ways:

1. **Semantic search:** pgvector ranks up to 20 chunks by cosine distance.
2. **Keyword search:** PostgreSQL full-text search ranks up to 20 matches using its English text-search configuration.
3. **Rank fusion:** reciprocal rank fusion combines the ranked lists.
4. **Context selection:** the top eight combined chunks become answer sources.

Both searches restrict results to the user's ready documents. There is no separate reranking model or relevance-threshold filter. Retrieval uses the current question; it does not rewrite follow-up questions using chat history.

### Streaming answers

The prompt contains instructions, numbered source excerpts, up to the last six conversation messages, and the new question. Six messages does not necessarily mean six complete question-and-answer turns.

The API calls OpenAI's Chat Completions endpoint directly with `fetch`, using `gpt-4o-mini` by default and temperature `0.2`.

The browser receives Server-Sent Event messages over a streaming `fetch` POST request:

| Event | Purpose |
| --- | --- |
| `sources` | Sends retrieved chunks, previews, and full passage text. |
| `token` | Appends generated answer text. |
| `done` | Confirms the saved assistant message and citation markers. |
| `degraded` | Reports an error after streaming began, including model or persistence failures. |

If generation fails after retrieval, sources and text already received can remain visible. An incomplete model answer is not normally saved as a completed assistant response. Failures before streaming, such as retrieval errors, return an ordinary HTTP error instead.

The prompt asks the model to answer only from sources and say when they are insufficient. This instruction does not guarantee correctness or complete factual support.

### Clickable citations

Excerpts receive answer-local numbers, and the model is asked to cite them with markers such as `[1]` or `[2][3]`.

After generation, the API extracts unique bracketed markers and saves references for valid source numbers. It does not independently verify that each passage supports the associated claim.

Clicking a citation opens its full extracted chunk inline. The passage number is derived from the chunk sequence, not a PDF page number. The viewer shows extracted text rather than the original PDF.

During a live answer, all retrieved sources are available. Reopening a saved answer restores the sources actually recorded as citations.

Deleting a document removes its chunks and citation references. Existing answer text can remain, but its old numbers may no longer open a source.

### Saved conversations

Conversations and messages are stored in PostgreSQL and associated with their owner. The sidebar lists conversations by creation time.

A new chat is created in the database when its first question is sent. If no title was supplied, the first question becomes its title, truncated to 80 characters.

Opening a conversation loads stored messages and citations. Deletion removes its messages and citations through database cascades.

### Suggested questions

The backend samples the first chunk from up to five recently created ready documents, taking up to 1,200 characters from each. It asks the chat model for three short questions, then parses JSON or falls back to line-based parsing.

The prompt requests questions under 12 words, but this length is not enforced in code. Suggestions are cached for 24 hours using the user ID and sampled document IDs. Changes outside the sampled set do not necessarily invalidate the cache.

Suggestions appear in an empty chat when ready documents are available. Failures return an empty list so the main chat remains usable.

### Rate limits and caching

With Redis configured, the API uses per-user token buckets:

| Action | Capacity | Refill |
| --- | --- | --- |
| Upload | 10 requests | 10 tokens per 24 hours |
| Ask a question | 20 requests | 20 tokens per hour |

These allow bursts and refill gradually; they are not fixed calendar-day or hourly counters. Rejections return HTTP 429 with `Retry-After`. Upload attempts consume capacity before validation and duplicate detection.

Question embeddings are cached for 24 hours using a normalized question hash. Suggestions have a separate cache. Generated chat answers are not cached.

Without Redis, the API uses an in-memory cache, disables rate limiting, and uses a no-op queue. Newly uploaded documents then remain queued. Redis is required for the complete ingestion workflow.

### Theme and session persistence

The interface supports light and dark themes, stores the choice locally, and uses system preference when no stored choice exists.

Local storage contains `docqa-token`, `docqa-user`, and `docqa-theme`. Conversation contents are stored on the server rather than in these browser settings.

## Development

Run commands from the repository root unless noted otherwise.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Starts workspace development scripts in parallel. |
| `pnpm --filter "./packages/*" build` | Builds shared packages required by consumers. |
| `pnpm build` | Builds packages and applications. |
| `pnpm typecheck` | Runs workspace TypeScript checks. |
| `pnpm test` | Runs test scripts, including API and worker Vitest suites. |
| `pnpm migrate` | Applies unapplied SQL migrations. |
| `pnpm --filter @docqa/api seed` | Creates or resets demo accounts. |
| `pnpm eval` | Runs retrieval evaluation using PostgreSQL and OpenAI. |
| `pnpm --filter @docqa/api eval --full` | Also generates and judges answers. |

API and worker development use `tsx watch`; production builds use TypeScript's compiler and start with `node dist/index.js`. The web app uses Next.js commands.

Production start scripts do not include the development scripts' root `--env-file` option. Supply service variables through the hosting platform or process environment.

## Technologies

Versions below describe manifest ranges or major versions. The lockfile pins installation resolutions.

| Technology | Role |
| --- | --- |
| TypeScript 5.5+ | Application code, contracts, and static checks. |
| pnpm 9.15.0 workspaces | Monorepo dependencies and scripts. |
| Next.js 15 | Web framework using the App Router. |
| React 19 | Login, document panel, chat, citations, and interface state. |
| CSS | Styling in `apps/web/app/globals.css`. |
| Fastify 5 | HTTP routes and API lifecycle. |
| `@fastify/cors` 10 | Cross-origin browser requests. |
| `@fastify/multipart` 9 | File uploads and upload limits. |
| Zod 3.23+ | Environment, request, and data schemas. |
| PostgreSQL / `pg` 8.12+ | Persistent records and SQL queries. |
| pgvector | Vector storage, cosine search, and HNSW indexing. |
| PostgreSQL full-text search | English keyword search and GIN indexing. |
| Redis / `ioredis` 5.4+ | Queue connections, caches, and rate-limit operations. |
| BullMQ 5.34+ | Ingestion jobs, retries, and concurrency. |
| `pdf-parse` 1.1.1+ | PDF text extraction. |
| `@aws-sdk/client-s3` 3.600+ | Optional S3-compatible file storage. |
| OpenAI HTTP APIs | Embeddings, answers, suggestions, and evaluation judging. |
| Node.js `crypto` | Password hashing, token signing, IDs, and hashes. |
| Pino 9 | Structured logging. |
| Vitest 2.1+ | API and worker tests. |
| `tsx` 4.19+ | TypeScript scripts and development watchers. |
| Docker / Fly.io configuration | Separate API and worker deployment. |
| GitHub Actions | Type checking, tests, and evaluation workflow. |

The app uses direct SQL and direct HTTP calls to OpenAI. It does not use an ORM, LangChain, an OpenAI SDK, or an implemented Anthropic integration.

## Architecture and data flow

```text
Browser / Next.js
    |
    | authenticated requests and streamed answers
    v
Fastify API --------------------------> OpenAI
    |                                  question embeddings,
    |                                  answers, suggestions
    +--> PostgreSQL + pgvector
    |    documents, chunks, users, chats, citations, events
    |
    +--> Redis
    |    BullMQ jobs, caches, rate-limit buckets
    |
    +--> Disk or S3-compatible storage <--- Background worker
         original uploaded bytes                |
                                                +--> extract and chunk
                                                +--> OpenAI embeddings
                                                +--> PostgreSQL chunks
```

### Upload path

`multipart upload → content check → per-user hash lookup → raw storage → queued record → BullMQ job`

The queue payload contains the document ID. The worker looks up the document and derives the storage key rather than receiving file bytes through Redis.

### Ingestion path

`job → processing → read original → extract → split → checkpoint → embed batches → store chunks → ready`

Chunks are upserted by document ID and sequence. Each stored batch uses a database transaction; one transaction does not span the full OpenAI interaction.

### Question path

`question → cached/new embedding → vector and keyword search → rank fusion → prompt → stream → saved answer and citations`

### Database structure

| Table | Information |
| --- | --- |
| `users` | ID, legacy GitHub ID field, email, username, password hash. |
| `documents` | Owner, title, size, hash, status, error. |
| `chunks` | Text, sequence, estimated token count, embedding, generated search vector. |
| `conversations` | Owner, title, creation time. |
| `messages` | Conversation, role, content, creation time. |
| `citations` | Links a message's numbered marker to a chunk. |
| `ingest_events` | Processing stages and JSON detail. |
| `schema_migrations` | Applied migration filenames. |

The schema includes HNSW and GIN indexes and supporting relational indexes. Unique constraints prevent duplicate content per user and duplicate chunk sequences per document.

Ownership checks are enforced by routes and SQL queries. The migrations do not define PostgreSQL Row-Level Security policies.

## File guide

```text
apps/
  web/
    app/page.tsx             Login, documents, conversations, chat, citations
    app/layout.tsx           Root layout and initial theme behavior
    app/globals.css          Interface styles
    lib/api.ts               HTTP client, local session, stream parser
  api/
    migrations/              Schema and password-auth migration
    src/index.ts             Configuration and dependency wiring
    src/server.ts            Fastify, errors, CORS, route registration
    src/config.ts            API environment validation
    src/auth.ts              Password hashing and signed tokens
    src/routes/              Login, documents, chats, suggestions, health
    src/repositories/        User, document, and conversation SQL
    src/db/                  Pool, migrations, demo-user seed
    src/retrieval.ts         Hybrid retrieval and rank fusion
    src/prompt.ts            Numbered context and citation parsing
    src/llm.ts               OpenAI calls and streaming
    src/suggestions.ts       Sampling, question generation, caching
    src/cache.ts             Redis and memory caches
    src/ratelimit.ts         Redis token buckets
    src/queue.ts             Ingestion producer
    src/sniff.ts             File-content checks
    src/eval/                Fixtures, questions, evaluation runner
  worker/
    src/index.ts             BullMQ consumer and shutdown
    src/config.ts            Worker environment validation
    src/pipeline.ts          Ingestion and checkpoint resume
    src/extract.ts           PDF/text extraction
    src/chunk.ts             Shared chunker access
    src/embed.ts             Embedding batches and retries
    src/db.ts                Worker SQL operations
packages/
  shared/src/index.ts        Schemas, queue contract, limits, model constants
  shared/src/chunk.ts        Text splitting and token estimation
  storage/src/index.ts      Disk/S3 adapters and storage keys
.github/workflows/
  ci.yml                    Install, package build, checks, tests
  eval.yml                  Retrieval evaluation
```

The API and worker also contain Dockerfiles and Fly.io configuration. Each package has its own package and TypeScript configuration.

## Understanding the code

### Shared contracts

In `packages/shared/src/index.ts`:

```ts
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const INGEST_QUEUE = "ingest";
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIM = 1536;
```

These constants keep services in agreement. Queue names must match, and embedding dimensions must match SQL. Changing the embedding model is a code/data migration concern, not simply a change to `CHAT_MODEL`.

This package also defines request schemas. Questions are limited to 2,000 characters.

### Splitting documents

In `packages/shared/src/chunk.ts`:

```ts
const DEFAULTS: ChunkOptions = { targetTokens: 500, overlapRatio: 0.15 };

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

This is a sizing estimate, not the model's tokenizer. Headings and paragraphs guide boundaries to preserve local context. Evaluation uses the same chunker as ingestion.

### Resuming ingestion

In `apps/worker/src/pipeline.ts`:

```ts
const checkpoint = await db.maxSeq(documentId);
const remaining = chunks.filter((c) => c.seq > checkpoint);
```

The highest stored sequence becomes the checkpoint. Resume assumes deterministic chunking and contiguous completed batches; it is not a record of completed PDF pages.

BullMQ allows three attempts with exponential backoff starting at five seconds. The embedding client separately retries transient 429 and server errors. Failed jobs are retained; there is no separate dead-letter queue or retry control in the interface.

### Combining search results

In `apps/api/src/retrieval.ts`:

```ts
scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
```

Each result contributes a score based on its rank, with `k = 60` by default. A chunk present in both lists receives both contributions. This avoids directly comparing cosine distances with text-search scores.

### Numbering sources

In `apps/api/src/prompt.ts`:

```ts
const sources = chunks
  .map((c, i) => `[${i + 1}] ${c.content}`)
  .join("\n\n");
```

The prompt assigns answer-local numbers. The marker parser recognizes one- or two-digit bracketed numbers, and the conversation route filters them against the retrieved-source count before saving citations.

### Coordinating a reply

`apps/api/src/routes/conversations.ts` checks ownership and limits, loads history, retrieves sources, and saves the question. It starts the stream, forwards sources and generated text, then saves the completed answer and citations.

Context is gathered before the new user message is stored so that question is not duplicated in history. Streaming, message storage, and citation insertion are not one atomic operation; late errors can occur after some data has been saved.

### Connecting the browser

In `apps/web/lib/api.ts`:

```ts
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
```

The client attaches the bearer token and handles authentication and rate-limit errors. Chat uses `fetch` to POST a question and parse streamed event blocks separated by blank lines. There is no automatic reconnect or cancel-generation feature.

### Selecting storage

`packages/storage/src/index.ts` selects S3 when the bucket name, access key ID, and secret key are all configured. Otherwise it selects disk storage.

Partial S3 configuration falls back to disk. Configure all three required values on both services when using shared object storage.

## Configuration

These variables are used by the implementation.

| Variable | Used by | Default / meaning |
| --- | --- | --- |
| `NODE_ENV` | API | `development`; also accepts test and production. |
| `PORT` | API | `3001`. |
| `HOST` | API | `0.0.0.0`. |
| `LOG_LEVEL` | API and worker | `info`; trace, debug, info, warn, or error. |
| `DATABASE_URL` | Services, DB scripts, evaluation | PostgreSQL connection string. |
| `REDIS_URL` | API and worker | Redis connection string. |
| `OPENAI_API_KEY` | Services and evaluation | Server-side model API key. |
| `AUTH_SECRET` | API | Token-signing secret; set a strong nonempty value. |
| `CHAT_MODEL` | API and evaluation | `gpt-4o-mini`; answers, suggestions, evaluation answers. |
| `WORKER_CONCURRENCY` | Worker | `2` simultaneous jobs. |
| `DATA_DIR` | Disk storage | `./data`; use a shared absolute path locally. |
| `BUCKET_NAME` | S3 storage | Required to select S3. |
| `AWS_ACCESS_KEY_ID` | S3 storage | Required to select S3. |
| `AWS_SECRET_ACCESS_KEY` | S3 storage | Required to select S3. |
| `AWS_ENDPOINT_URL_S3` | S3 storage | Optional custom endpoint. |
| `AWS_REGION` | S3 storage | `auto`. |
| `NEXT_PUBLIC_API_URL` | Web | `http://localhost:3001`; public API base URL. |

`ANTHROPIC_API_KEY`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` appear in `.env.example` but are not used by implemented flows.

The embedding model is a shared code constant, not an environment setting. The optional evaluation judge separately hardcodes `gpt-4o-mini`.

### Reduced startup modes

- Without `DATABASE_URL`, the API starts with health endpoints only.
- With the database configured, login and document routes are available.
- Conversation and suggestion routes require both database and OpenAI configuration. This includes conversation CRUD, not just answer generation.
- Without Redis, uploads do not reach a real queue and rate limits are disabled.

The worker expects database, Redis, and OpenAI settings for normal operation.

## API reference

Protected routes require a valid bearer token.

| Method | Route | Function |
| --- | --- | --- |
| GET | `/healthz` | Basic liveness. |
| GET | `/readyz` | Configured database readiness check. |
| POST | `/auth/login` | Username/password login. |
| POST | `/documents` | Multipart upload; 202 new, 200 duplicate. |
| GET | `/documents` | List owned documents. |
| GET | `/documents/:id` | Document and ingestion events. |
| DELETE | `/documents/:id` | Delete document and attempt raw-file cleanup. |
| POST | `/conversations` | Create, optionally with a title. |
| GET | `/conversations` | List owned conversations. |
| GET | `/conversations/:id` | Load messages and citations. |
| DELETE | `/conversations/:id` | Delete conversation. |
| POST | `/conversations/:id/messages` | Accept `{ "question": "..." }`; stream reply. |
| GET | `/suggestions` | Return `{ "questions": [...] }`. |

`/readyz` does not verify Redis, OpenAI, storage, or worker availability. Without a configured database, it does not establish that the document application is functional. There is no original-file download endpoint.

## Tests and evaluation

### Automated tests

API and worker Vitest tests cover authentication, token tampering and expiry, document operations, duplicates, rate-limit responses, conversation operations, streaming, degraded generation, citations, prompt construction, rank fusion, suggestions, chunking, and ingestion checkpoints and failures.

Several tests inject fake repositories, storage, retrieval, or model dependencies. They do not replace an end-to-end check against real services.

The web package has a placeholder test script. Shared and storage packages also lack standalone test suites in their package scripts, although consumers exercise some behavior.

### Retrieval evaluation

The harness uses 30 handwritten questions over three Markdown fixtures: the Aurora handbook, Atlas specification, and operations runbook.

It creates an evaluation user and ingests chunks directly into PostgreSQL, bypassing uploads, raw storage, BullMQ, and PDF parsing. It embeds questions and runs normal hybrid retrieval.

**Hit@8** counts a question as a hit when any retrieved chunk contains its gold-answer substring. It does not check document identity or score a complete generated answer. A rate below 0.70 produces an unsuccessful exit.

With `--full`, it also generates answers and asks a model whether they are supported by excerpts. The faithfulness percentage is reported but is not another pass/fail gate. The fixture's `expect` field is not used as the judge's reference answer.

Use an already migrated evaluation database. Evaluation writes records, calls OpenAI, and does not clean up all data afterward. The runner skips without required settings, but its script still loads root `.env`; a missing file can fail before the skip.

### Continuous integration

The main workflow installs locked dependencies, builds shared packages, checks types, and runs tests on pushes to `main` and pull requests.

A separate workflow runs retrieval evaluation for selected changes or manual dispatch. It expects database and OpenAI secrets but does not create the root `.env` required by the script or run migrations. Address those setup gaps before relying on it as an evaluation gate.

## Deployment

### API and worker containers

Build from the repository root so workspace packages are available:

```sh
docker build -f apps/api/Dockerfile -t docqa-api .
docker build -f apps/worker/Dockerfile -t docqa-worker .
```

Both images use Node.js 22. The API image includes migrations, but startup does not automatically apply them. Provide environment settings through deployment configuration and apply migrations as an explicit setup/release step.

For separate machines, configure shared S3-compatible storage. Individual container filesystems are not shared; the Fly.io configurations do not declare persistent volumes.

### Fly.io

Separate API and worker configurations include existing app names, a Frankfurt region, and small machine allocations. Replace app names for your deployment and size services for your workload.

Use the repository root as build context and explicitly select the service Dockerfile. The configurations' `Dockerfile` references alone do not describe a root-level Dockerfile.

The API exposes port 3001 and checks `/healthz`. The worker has no public HTTP server. API liveness does not confirm worker health or successful ingestion.

### Web app

Use a Next.js-compatible host such as Vercel, with `apps/web` as the web application directory. Configure workspace installation/build so shared packages build before consumers.

Set `NEXT_PUBLIC_API_URL` to the deployed API's HTTPS URL before building. Public Next.js variables are included in the browser build.

The API currently reflects request origins through CORS; it has no environment-configured origin allowlist.

## Current behavior and limitations

- Document text and questions are sent to OpenAI; this is not an offline-only application.
- Authentication has no registration, password reset, OAuth, or login-specific rate limiter.
- There is no OCR, original-PDF viewer, document sharing, document-specific chat filter, or stream reconnect.
- Answers use retrieved excerpts; retrieval can miss relevant information. Citation parsing checks numbers, not factual support.
- The UI renders answer text and citation controls rather than a full Markdown renderer.
- File storage, document insertion, and enqueueing are separate operations. Partial failures can leave orphaned files or queued records.
- Raw-file deletion is best effort and may fail after database deletion succeeds.
- Question-embedding cache keys lack a user or embedding-model namespace. Clear or version the cache when changing embedding behavior.
- Re-uploading identical failed content returns its existing record rather than retrying processing.
- No root license file was present in the inspected source. Repository visibility alone does not specify an open-source license.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Shared package cannot be imported | Build `./packages/*` before starting consumers. |
| Database or missing-table errors | Check connection settings, vector extension, and migrations. |
| Demo login fails | Seed the same database used by the API. |
| Sessions fail across instances | Use the same nonempty `AUTH_SECRET` on every API instance. |
| Chat routes return 404 | Configure both database and OpenAI before API startup. |
| Documents stay queued | Check Redis, worker availability, and matching service configuration. |
| Worker cannot find an upload | Use the same absolute disk path or complete shared S3 settings. |
| PDF has no extracted text | Confirm it contains selectable text; OCR is not implemented. |
| Upload returns 415 | Content was rejected as unsupported binary data. |
| Upload exceeds limit | Keep files under the 20 MiB server limit. |
| Request returns 429 | Wait for `Retry-After` and bucket refill. |
| Model error | Check credentials, model access, logs, and upstream availability. |
| No suggestions | Wait for ready documents; generation failures return an empty list. |
| Old citation does not open | The source document or chunk may have been deleted. |
| Browser cannot reach deployed API | Check build-time API URL, HTTPS, and reachability. |
| Evaluation fails before running | Ensure root `.env` exists and the database is migrated. |

## Suggested reading order

1. `packages/shared/src/index.ts` for contracts and limits.
2. `apps/web/app/page.tsx` and `apps/web/lib/api.ts` for the user workflow.
3. `apps/api/src/index.ts` and `apps/api/src/server.ts` for dependency wiring.
4. The document route and `apps/api/src/queue.ts` for uploads.
5. `apps/worker/src/pipeline.ts` and the shared chunker for ingestion.
6. `apps/api/src/retrieval.ts` for search.
7. Prompt, LLM, and conversation modules for answers and citations.
8. `apps/api/migrations/` for persistence and indexes.
9. Tests and `apps/api/src/eval/` for automated checks and retrieval measurements.

---

Documented from [the inspected repository revision](https://github.com/pascalmmk/docqa/tree/aa1b15368d9873ce0f7781b78fabd86963536eaa). Setup and behavior were checked against source code; this documentation review did not run a live deployment or external-service evaluation.
