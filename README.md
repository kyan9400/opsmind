# OpsMind

[![CI](https://github.com/kyan9400/opsmind/actions/workflows/ci.yml/badge.svg)](https://github.com/kyan9400/opsmind/actions/workflows/ci.yml)

**An AI-powered operations and knowledge platform for small businesses.**
Teams upload their documents and connect operational data, then get cited AI answers, live KPI dashboards with anomaly hints, and multi-tenant, role-based administration — all shipped with CI/CD, containers and observability.

> Status: **Week 3 of 5 — Analytics** (KPI dashboard, anomaly detection, Excel/PDF reports) on top of the RAG pipeline and the Week 1 foundation. See the [roadmap](#roadmap).

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
| Queue & cache | Redis + BullMQ (retries with exponential backoff); versioned cache keys |
| Reports | ExcelJS (typed cells, number formats), PDFKit (vector sparklines, DejaVu for Cyrillic/Arabic) |
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

## KPI analytics

Businesses bring their numbers as a **CSV in long format** (`date,metric,value`), the shape every spreadsheet can export. Or an admin clicks **Load demo data** for 180 days of realistic metrics: growth trend, weekend dips, noise, and six injected incidents.

- **Import** (`POST /api/v1/metrics/import`, member+): comma, semicolon and tab files; `YYYY-MM-DD` or `DD.MM.YYYY` dates; `12 400,50` or `12,400.50` numbers. Bad rows are reported with their line number instead of failing the file. Points are bulk-upserted with `unnest()` in 10k-row batches, one transaction per file; re-importing a day overwrites it.
- **Dashboard** (`GET /api/v1/metrics/dashboard?days=30&bucket=week`): current vs previous period in a single SQL pass (`FILTER` clauses), and a series bucketed by day, week or month with `date_trunc`. Each metric knows whether it is a **total or an average** (revenue vs resolution time) and **which direction is good** (revenue up vs tickets up), which drives the delta colours and whether an anomaly is a problem. Buckets cut off by the period edge are flagged `partial` and drawn hollow.
- **AI insights** (`GET /api/v1/metrics/insights`): the Python service scores every day with a **seasonal robust z-score**:
  - *expected* = the median of the same weekday over the previous 8 weeks, so normal weekend dips are not "anomalies"
  - *noise* = the MAD of **leave-one-out** residuals across the whole 8-week window (~56 samples); in-sample residuals underestimate noise and cause false alarms
  - flagged when |z| ≥ 3.5 (Iglewicz & Hoaglin), "high" severity at 6

  Results are summarised in plain language, by the configured LLM or a deterministic template. They are cached in Redis under a per-tenant **data-version key** that every import or edit bumps, so invalidation is O(1) with no key scans.
- **Reports** (`GET /api/v1/metrics/export?format=xlsx|pdf`): an Excel workbook (summary with conditional delta colours, wide daily data with real date cells, anomalies sheet) or a PDF with KPI cards and sparklines. If the AI service is down, the report still generates without the insights section.

**Measured detector behaviour** (`services/ai/tests`, ±5% noise with weekly seasonality):

| | Result |
|---|---|
| False alarms on incident-free data | 2 in 15,000 day-checks (0.013%) |
| 20% drop detected | 97% |
| ≥ 25% drop detected | 100% |
| Demo data, 90 days × 6 metrics | all 6 injected incidents found, 0 false alarms |

The charts follow a documented data-viz spec: one metric per chart (never two y-axes), 2px lines with a 10% area wash, hairline grid, a crosshair tooltip that snaps to dates and works with arrow keys, status-coloured anomaly markers (always paired with an icon and label, never colour alone), a table view for every chart, and a validated palette with separate light and dark steps.

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
| GET | `/api/v1/metrics` | viewer+ | Metric definitions |
| GET | `/api/v1/metrics/dashboard?days&bucket&to` | viewer+ | Period vs previous period + bucketed series |
| GET | `/api/v1/metrics/insights?days&to` | viewer+ | Anomalies + narrative summary (cached) |
| GET | `/api/v1/metrics/export?format=xlsx\|pdf&days&bucket` | viewer+ | Download report (audited) |
| POST | `/api/v1/metrics/import` | member+ | CSV upload (multipart `file`) with per-line errors |
| POST | `/api/v1/metrics/demo` | admin+ | Load 180 days of demo KPIs |
| PATCH | `/api/v1/metrics/:id` | admin+ | Name, unit, total/average, good direction |
| DELETE | `/api/v1/metrics/:id` | admin+ | Delete a metric and its data |

## Testing

```bash
npm test -w apps/api                       # unit + HTTP tests
INTEGRATION=1 npm test -w apps/api         # + Postgres integration tests
cd services/ai && pytest -q                # AI service (INTEGRATION=1 for pgvector tests)
bash scripts/smoke.sh                      # end-to-end against a running stack
```

CI runs every suite against real Postgres + Redis service containers. It then starts the whole stack with `docker compose` and runs the **end-to-end smoke test**:
- register → upload → the worker indexes it → ask → assert a cited answer
- load demo KPIs → dashboard → assert every injected incident is detected → download both reports and check their file signatures

## Roadmap

- [x] **Week 1 — Foundation:** monorepo, auth, multi-tenancy, RBAC, audit log, Docker, CI
- [x] **Week 2 — RAG:** document upload, ingestion queue, embeddings in pgvector, hybrid search (vector + full-text, RRF), cited answers, local LLM option
- [x] **Week 3 — Analytics:** KPI dashboard, CSV import, seasonal anomaly detection with AI summaries, Excel/PDF reports
- [ ] **Week 4 — Ops:** Kubernetes manifests / Helm, Terraform, OpenTelemetry + Prometheus + Grafana, k6 load tests
- [ ] **Week 5 — Polish:** EN/RU/AR (RTL), Playwright e2e, RAG eval metrics, demo video

## Author

**Alhassan Alfarran** — Software & DevOps Engineer · [Portfolio](https://alhassan-portfolio-sigma.vercel.app/) · [GitHub](https://github.com/kyan9400)
