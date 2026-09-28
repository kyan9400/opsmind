# OpsMind

[![CI](https://github.com/kyan9400/opsmind/actions/workflows/ci.yml/badge.svg)](https://github.com/kyan9400/opsmind/actions/workflows/ci.yml)

**An AI-powered operations and knowledge platform for small businesses.**
Teams upload their documents and connect operational data, then get cited AI answers, live KPI dashboards with anomaly hints, and multi-tenant, role-based administration — all shipped with CI/CD, containers and observability.

> Status: **Week 2 of 5 — RAG** (document ingestion, hybrid retrieval, cited answers) on top of the Week 1 foundation. See the [roadmap](#roadmap).

## Architecture

```
          ┌──────────────┐        ┌───────────────────┐        ┌──────────────────┐
browser → │  Next.js web │ ─────► │  Node.js API (TS) │ ─────► │ PostgreSQL       │
          │  apps/web    │  REST  │  apps/api         │   SQL  │ + pgvector       │
          └──────────────┘        └────────┬──────────┘        └──────────────────┘
                                           │ enqueue                        ▲
                                           ▼                                │ chunks + vectors
                                  ┌───────────────────┐  /v1/ingest ┌──────┴────────────┐
                                  │ Worker (BullMQ)   │ ──────────► │ Python AI service │
                                  │ Redis queue       │             │ extract → chunk → │
                                  └───────────────────┘   /v1/ask   │ embed → retrieve  │
                                           API ───────────────────► │ → answer + cite   │
                                                                    └───────────────────┘
```

| Layer | Stack |
|---|---|
| Web | Next.js 15, React 19, TypeScript, Tailwind CSS 4 |
| API | Node.js, Express 5, Zod, JWT, bcrypt, pino |
| Data | PostgreSQL 16 + pgvector, Redis |
| AI | Python 3.12, FastAPI, pgvector, pypdf; OpenAI / Claude / Ollama |
| Queue | Redis + BullMQ (retries with exponential backoff) |
| Delivery | Docker, docker compose, GitHub Actions |

## Design decisions

- **Tenant isolation by construction.** `tenant_id` is read only from the signed JWT, never from the request, and every query is scoped by it. An integration test proves one tenant cannot see another's users.
- **Role hierarchy `viewer < member < admin < owner`.** You can only grant or change roles strictly below your own, so an admin cannot mint another admin.
- **Append-only audit log** with a `(tenant_id, created_at DESC)` index and keyset pagination, so the "recent activity" query stays O(limit) as the table grows.
- **No account enumeration.** Unknown email and wrong password return the same error.
- **Production-shaped from day one.** Multi-stage non-root images, health and readiness endpoints, graceful shutdown for rolling deploys, and migrations run on startup.

## How the RAG pipeline works

1. **Upload** (`POST /api/v1/documents`, member+): PDF / TXT / Markdown up to 10 MB is stored and a job is queued. The API answers `202 Accepted` right away.
2. **Worker** picks up the job and calls the AI service. Transient failures (AI service down, 5xx) retry 3× with exponential backoff; unreadable files fail fast (`UnrecoverableError`) and the error is shown on the document.
3. **Ingest**: extract text → normalise → split into ~800-char chunks with 100-char overlap on paragraph/sentence boundaries → embed in batches → replace the document's chunks **in one transaction**, so re-indexing never leaves a half-indexed document.
4. **Ask** (`POST /api/v1/ask`, viewer+): the question is embedded, then two candidate lists are retrieved **for the caller's tenant only**:
   - vector similarity (pgvector cosine, HNSW index)
   - full-text match (`tsvector`, `simple` config so EN / RU / AR all work)

   They are merged with **Reciprocal Rank Fusion**. This catches exact terms (IDs, names) that embeddings miss, and paraphrases that keyword search misses.
5. **Answer**: the top chunks are numbered and sent to the LLM, which must cite `[n]`. The prompt treats sources as untrusted data (a prompt-injection guard). The response marks which sources were actually cited.

### Providers

| | Offline default | Hosted | Local |
|---|---|---|---|
| Embeddings (`EMBED_PROVIDER`) | `hash`: deterministic feature hashing, lexical only | `openai` (`text-embedding-3-small`, 768-d) | `ollama` (`nomic-embed-text`) |
| Answers (`LLM_PROVIDER`) | `extractive`: best-matching source sentences, cited | `openai`, `anthropic` | `ollama` (`llama3.1`) |

The offline defaults need no API keys, so CI and a fresh `docker compose up` work out of the box. Switch to a real model for semantic quality:

```bash
# Fully local, private: nothing leaves the machine
docker compose --profile local-llm up -d
docker compose exec ollama ollama pull nomic-embed-text
docker compose exec ollama ollama pull llama3.1
EMBED_PROVIDER=ollama LLM_PROVIDER=ollama docker compose up -d ai worker
```

> Changing `EMBED_PROVIDER` changes the vector space, so reindex existing documents afterwards (`POST /api/v1/documents/:id/reindex`).

## Run it locally

```bash
cp .env.example .env
docker compose up --build
```

- Web: http://localhost:3000
- API: http://localhost:4000/health
- AI service: http://localhost:8000/docs

Without Docker (Postgres required):

```bash
npm install
npm run migrate -w apps/api
npm run dev:api     # :4000
npm run dev:worker -w apps/api
cd services/ai && uvicorn app.main:app --reload --port 8000
npm run dev:web     # :3000
```

## API (v1)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/v1/auth/register` | public | Create a tenant and its owner |
| POST | `/api/v1/auth/login` | public | Get a JWT |
| GET | `/api/v1/auth/me` | any | Current user and tenant |
| GET | `/api/v1/users` | viewer+ | List tenant users |
| POST | `/api/v1/users` | admin+ | Add a user (lower role only) |
| PATCH | `/api/v1/users/:id/role` | admin+ | Change role (audited) |
| GET | `/api/v1/audit?limit&before` | admin+ | Keyset-paginated audit trail |
| GET | `/api/v1/documents` | viewer+ | List documents and indexing status |
| POST | `/api/v1/documents` | member+ | Upload (multipart `file`); returns 202 |
| GET | `/api/v1/documents/:id` | viewer+ | Document status |
| POST | `/api/v1/documents/:id/reindex` | admin+ | Re-run ingestion |
| DELETE | `/api/v1/documents/:id` | admin+ | Delete document and its chunks |
| POST | `/api/v1/ask` | viewer+ | `{question, topK}` → cited answer |

## Testing

```bash
npm test -w apps/api                       # unit + HTTP tests
INTEGRATION=1 npm test -w apps/api         # + Postgres integration tests
cd services/ai && pytest -q                # AI service (INTEGRATION=1 for pgvector tests)
bash scripts/smoke.sh                      # end-to-end against a running stack
```

CI runs every suite against real Postgres + Redis service containers. It then starts the whole stack with `docker compose` and runs the **end-to-end smoke test**: register → upload → the worker indexes it → ask → assert a cited answer.

## Roadmap

- [x] **Week 1 — Foundation:** monorepo, auth, multi-tenancy, RBAC, audit log, Docker, CI
- [x] **Week 2 — RAG:** document upload, ingestion queue, embeddings in pgvector, hybrid search (vector + full-text, RRF), cited answers, local LLM option
- [ ] **Week 3 — Analytics:** KPI dashboard, AI anomaly hints, Excel/PDF export
- [ ] **Week 4 — Ops:** Kubernetes manifests / Helm, Terraform, OpenTelemetry + Prometheus + Grafana, k6 load tests
- [ ] **Week 5 — Polish:** EN/RU/AR (RTL), Playwright e2e, RAG eval metrics, demo video

## Author

**Alhassan Alfarran** — Software & DevOps Engineer · [Portfolio](https://alhassan-portfolio-sigma.vercel.app/) · [GitHub](https://github.com/kyan9400)
