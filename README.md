# OpsMind

[![CI](https://github.com/kyan9400/opsmind/actions/workflows/ci.yml/badge.svg)](https://github.com/kyan9400/opsmind/actions/workflows/ci.yml)

**An AI-powered operations and knowledge platform for small businesses.**
Teams upload their documents and connect operational data, then get cited AI answers, live KPI dashboards with anomaly hints, and multi-tenant, role-based administration — all shipped with CI/CD, containers and observability.

> All five milestones are done: multi-tenant foundation, RAG, KPI analytics, operations, and polish (three languages, browser tests, measured retrieval quality, demo workspace). See the [roadmap](#roadmap).

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

### Retrieval quality

Hybrid search is measured, not assumed. [`services/ai/eval`](services/ai/eval/README.md) contains 12 company policies (English, Russian, Arabic) and 56 labelled questions: exact codes and IDs, natural questions, paraphrases, and cross-language questions. Every CI run (`rag-eval` job) indexes them through the real `/v1/ingest` path and asks each question with vector-only, full-text-only and hybrid (RRF) retrieval. It reports Recall@1/3/5 and MRR by question kind and language, and fails if hybrid Recall@5 drops below 0.8.

The evaluation already paid for itself. It showed that `websearch_to_tsquery` ANDs every word, so the full-text leg matched almost no natural-language question. Full-text now ORs the question's content words (EN/RU/AR stop words dropped) and lets `ts_rank_cd` rank the chunks.

> The latest numbers are in the CI job summary and the `rag-eval-results` artifact, measured with the offline `hash` embedder. That embedder is lexical, so paraphrase and cross-language questions are its known weak spot. A real embedding model (`EMBED_PROVIDER=openai` or `ollama`) is expected to help there; it has not been measured on this dataset.

## KPI analytics

Businesses bring their numbers as a **CSV in long format** (`date,metric,value`), the shape every spreadsheet can export. Or an admin clicks **Load demo data** for 180 days of realistic metrics: growth trend, weekend dips, noise, and six injected incidents.

- **Import** (`POST /api/v1/metrics/import`, member+): comma, semicolon and tab files; `YYYY-MM-DD` or `DD.MM.YYYY` dates; `12 400,50`, `1.234,56` or `12,400.50` numbers.
  - The decimal separator is decided by position and by the file's delimiter, so a quoted `"12,400"` is never read as 12.4.
  - Bad rows, including values that split across columns and malformed quotes, are reported with their physical line number instead of failing the file.
  - Points are bulk-upserted with `unnest()` in 10k-row batches, one transaction per file; re-importing a day overwrites it.
  - A workspace can track up to 100 metrics, enforced under a row lock, since every view is O(metrics × days).
- **Dashboard** (`GET /api/v1/metrics/dashboard?days=30&bucket=week`): current vs previous period in a single SQL pass (`FILTER` clauses), and a series bucketed by day, week or month with `date_trunc`. Each metric knows whether it is a **total or an average** (revenue vs resolution time) and **which direction is good** (revenue up vs tickets up), which drives the delta colours and whether an anomaly is a problem. Buckets cut off by the period edge are flagged `partial` and drawn hollow.
- **AI insights** (`GET /api/v1/metrics/insights`): the Python service scores every day with a **seasonal robust z-score**:
  - *expected* = the median of the same weekday over the previous 8 weeks, so normal weekend dips are not "anomalies"
  - *noise* = the MAD of **leave-one-out** residuals across the whole 8-week window (~56 samples); in-sample residuals underestimate noise and cause false alarms
  - a day is scored only once its weekday has 4 weeks of history; a non-seasonal fallback would compare Sundays with Mondays
  - sparse counts (refunds that are 0 on most days) fall back from MAD to mean absolute deviation, so they don't flood the page with alerts
  - flagged when |z| ≥ 3.5 (Iglewicz & Hoaglin), "high" severity at 6

  Results are summarised in plain language, by the configured LLM or a deterministic template. They are cached in Redis under a per-tenant **data-version key** that every import or edit bumps, so invalidation is O(1) with no key scans.
- **Reports** (`GET /api/v1/metrics/export?format=xlsx|pdf`): an Excel workbook (summary with conditional delta colours, wide daily data with real date cells, anomalies sheet) or a PDF with KPI cards and sparklines. If the AI service is down, the report still generates without the insights section.

**Measured detector behaviour** (`services/ai/tests`, ±5% noise with weekly seasonality):

| | Result |
|---|---|
| False alarms on incident-free data | 2 in 15,000 day-checks (0.013%) |
| 20% drop detected | 97% |
| ≥ 25% drop detected | 100% |
| Demo data, 30 / 90 / 180-day views | exactly the injected incidents (5 / 6 / 6), 0 false alarms |
| Sparse 0/1 counts (P(1) = 25%) | ≤ 2.5 alerts per 30 days (was ~10 before the MAD fallback) |

The charts follow a documented data-viz spec: one metric per chart (never two y-axes), 2px lines with a 10% area wash, hairline grid, a crosshair tooltip that snaps to dates and works with arrow keys, status-coloured anomaly markers (always paired with an icon and label, never colour alone), a table view for every chart, and a validated palette with separate light and dark steps.

## Operations

### Observability

Metrics, dashboards and distributed tracing run as an optional overlay on the normal stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up --build
```

| Tool | URL | Notes |
|---|---|---|
| Grafana | http://localhost:3001 | Opens on the **OpsMind overview** dashboard (anonymous read-only) |
| Prometheus | http://localhost:9090 | Scrapes `api:4000`, `worker:9100`, `ai:8000` every 15s; alert rules under *Alerts* |
| Jaeger | http://localhost:16686 | Traces from `opsmind-api`, `opsmind-worker`, `opsmind-ai` |

- **Metrics**: RED histograms per *route template* (never raw URLs, so IDs can't explode cardinality), ingestion queue depth, job duration and outcomes, embedding and LLM latency per provider, anomalies by severity, and cache hit ratio. Runtime metrics come from every process.
- **Dashboard** (`ops/grafana/dashboards`), organised from symptoms to causes: at a glance, traffic and errors, latency p50/p95/p99, ingestion pipeline, AI service, runtime, insights cache.
- **Alerts** (`ops/prometheus/alerts.yml`), each with runbook notes: 5xx ratio, API p95 above 1s, ingest backlog, ingest failure rate, target down.
- **One trace per request, across services.** An upload's HTTP span starts the trace. The trace context travels *inside the queue job*, so the worker's `ingest document` span continues it. The call to the AI service carries `traceparent`, so its request span, embedding calls and every SQL insert appear in the same waterfall. Tracing costs nothing unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

### Kubernetes

A hardened Helm chart (`deploy/helm/opsmind`) deploys the API, worker, AI service and web UI, with optional in-cluster Postgres (pgvector) and Redis.

- **Migrations** run in an API initContainer. They are serialized by a Postgres advisory lock, so replicas and rolling updates can start concurrently.
- **Secrets** are generated on first install and reused on upgrade, or you supply your own with `secrets.existingSecret`.
- **Hardening**: non-root, read-only root filesystem, all capabilities dropped, seccomp `RuntimeDefault`, and no service-account token. NetworkPolicies allow only the paths the app uses (e.g. only api/worker may reach the AI service).
- **Scaling**: HPAs for api and ai, PDBs for every tier, zero-downtime rolling updates with a preStop drain.
- **CI runs it for real.** The `kind` job builds the images, installs the chart into a throwaway Kubernetes cluster with NetworkPolicies on, and runs the **same end-to-end smoke test** as Docker Compose (upload → index → cited answer → KPI anomalies → reports), plus `helm test`.

```bash
helm upgrade --install opsmind deploy/helm/opsmind -n opsmind --create-namespace \
  --set ingress.enabled=true --set ingress.host=opsmind.example.com
```

### Load testing

[k6](https://k6.io) scripts live in [`load/`](load/README.md). Each run registers its own tenant, loads the demo KPIs, indexes a document, then ramps 0 → 20 → 50 → 0 virtual users over a read-heavy mix (50% dashboard, 20% insights, 15% ask, 10% documents, 5% me).

| Endpoint | p95 budget |
|---|---:|
| `GET /metrics/dashboard` | 300 ms |
| `GET /metrics/insights` (cached) | 200 ms |
| `POST /ask` | 800 ms |
| `GET /documents` | 200 ms |
| `GET /auth/me` | 100 ms |

The CI `load` job fails if any budget or the 1% error budget is exceeded, and publishes a p50/p95/p99 table in the run summary.

### Deployment

Production is one Ubuntu VM running the same images with Docker Compose. [Caddy](https://caddyserver.com) is the only public entrypoint, with automatic Let's Encrypt HTTPS, security headers (HSTS, CSP) and HTTP/3. Postgres, Redis, the AI service and `/metrics` are never exposed.

| Piece | Where |
|---|---|
| VM, firewall, static IP, first-boot setup (Yandex Cloud) | `infra/terraform/yandex` |
| Production overrides: Caddy, no host ports, restart policies, log rotation, memory limits | `docker-compose.prod.yml` |
| Continuous deployment after green CI on `main` | `.github/workflows/deploy.yml` |

```bash
cd infra/terraform/yandex
cp terraform.tfvars.example terraform.tfvars   # cloud/folder IDs, SSH key, your IP
export YC_TOKEN=$(yc iam create-token)
terraform init && terraform apply              # prints app_url, e.g. https://203-0-113-7.sslip.io
```

Secrets are generated by Terraform and never stored in git. Deploys only ship commits that passed CI and wait for `/ready`. The compose part runs on any Ubuntu 22.04/24.04 VPS. Full guide: [infra/README.md](infra/README.md).

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

## Try the demo

A read-only demo workspace ("Northwind Supply") has 180 days of KPIs with real incidents to find, and four company policies to ask questions about:

```bash
docker compose exec -e DEMO_EMAIL=demo@opsmind.dev -e DEMO_PASSWORD='choose-one' api node dist/seedDemo.js
```

Visitors log in as **viewers**. They can explore dashboards, ask the AI and download reports, but cannot upload, import or change anything; CI checks this. Build the web image with `NEXT_PUBLIC_DEMO_EMAIL` / `NEXT_PUBLIC_DEMO_PASSWORD` to show a one-click **Try the live demo** button. Login and registration are rate-limited per IP.

The UI is available in **English, Russian and Arabic**. Arabic uses a full right-to-left layout, and the language is rendered server-side, so the first paint is already correct.

## Testing

```bash
npm test -w apps/api                       # unit + HTTP tests
INTEGRATION=1 npm test -w apps/api         # + Postgres integration tests
cd services/ai && pytest -q                # AI service (INTEGRATION=1 for pgvector tests)
bash scripts/smoke.sh                      # end-to-end against a running stack
npm ci && npx playwright install chromium   # once: browser for the e2e suite
AUTH_RATE_LIMIT=0 docker compose up -d --build
npm test -w e2e                            # Playwright browser tests against http://localhost:3000
SCREENSHOTS=1 npm test -w e2e              # regenerate the README screenshots
```

CI runs every suite against real Postgres + Redis service containers. It then starts the whole stack with `docker compose` and runs the **end-to-end smoke test**:
- register → upload → the worker indexes it → ask → assert a cited answer
- load demo KPIs → dashboard → assert every injected incident is detected → download both reports and check their file signatures

**Browser tests** ([`e2e/`](e2e)) drive the real UI with Playwright against the full `docker compose` stack. Each spec creates its own workspace and selects elements by `data-testid`, so copy changes and translations don't break them:
- **auth**: register → dashboard → sign out → sign in; a wrong password shows an error
- **documents + ask**: upload a policy → wait for indexing → cited answer
- **analytics**: demo KPIs, anomalies, 90-day weekly view, table view, Excel download
- **rbac**: a viewer sees no upload, import or demo controls, and the API refuses them too
- **i18n**: Russian and Arabic (RTL) switch `<html lang/dir>` and survive a reload

CI runs ten jobs on every change: unit, integration, compose e2e, browser, retrieval evaluation, load test, Kubernetes (kind), infrastructure validation and observability config checks.

## Roadmap

- [x] **Week 1 — Foundation:** monorepo, auth, multi-tenancy, RBAC, audit log, Docker, CI
- [x] **Week 2 — RAG:** document upload, ingestion queue, embeddings in pgvector, hybrid search (vector + full-text, RRF), cited answers, local LLM option
- [x] **Week 3 — Analytics:** KPI dashboard, CSV import, seasonal anomaly detection with AI summaries, Excel/PDF reports
- [x] **Week 4 — Ops:** Prometheus metrics, Grafana dashboards and alerts, OpenTelemetry tracing across services and the queue, Helm chart tested on kind, Terraform (Yandex Cloud) + Caddy HTTPS + CD, k6 load tests
- [x] **Week 5 — Polish:** EN/RU/AR with RTL, Playwright browser tests, retrieval evaluation (Recall@k / MRR in CI), read-only demo workspace, login rate limiting

## Author

**Alhassan Alfarran** — Software & DevOps Engineer · [Portfolio](https://alhassan-portfolio-sigma.vercel.app/) · [GitHub](https://github.com/kyan9400)
