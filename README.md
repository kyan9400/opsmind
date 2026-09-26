# OpsMind

[![CI](https://github.com/kyan9400/opsmind/actions/workflows/ci.yml/badge.svg)](https://github.com/kyan9400/opsmind/actions/workflows/ci.yml)

**An AI-powered operations and knowledge platform for small businesses.**
Teams upload their documents and connect operational data, then get cited AI answers, live KPI dashboards with anomaly hints, and multi-tenant, role-based administration — all shipped with CI/CD, containers and observability.

> Status: **Week 1 of 5 — foundation** (auth, multi-tenancy, RBAC, audit log, CI). See the [roadmap](#roadmap).

## Architecture

```
          ┌──────────────┐        ┌───────────────────┐        ┌──────────────────┐
browser → │  Next.js web │ ─────► │  Node.js API (TS) │ ─────► │ PostgreSQL       │
          │  apps/web    │  REST  │  apps/api         │   SQL  │ + pgvector       │
          └──────────────┘        └────────┬──────────┘        └──────────────────┘
                                           │ jobs (Redis / BullMQ)
                                           ▼
                                  ┌───────────────────┐
                                  │ Python AI service │  chunk → embed → retrieve → answer
                                  │ services/ai       │  (FastAPI; OpenAI/Claude or local Ollama)
                                  └───────────────────┘
```

| Layer | Stack |
|---|---|
| Web | Next.js 15, React 19, TypeScript, Tailwind CSS 4 |
| API | Node.js, Express 5, Zod, JWT, bcrypt, pino |
| Data | PostgreSQL 16 + pgvector, Redis |
| AI | Python 3.12, FastAPI (RAG pipeline) |
| Delivery | Docker, docker compose, GitHub Actions |

## Design decisions

- **Tenant isolation by construction.** `tenant_id` is read only from the signed JWT, never from the request, and every query is scoped by it. An integration test proves one tenant cannot see another's users.
- **Role hierarchy `viewer < member < admin < owner`.** You can only grant or change roles strictly below your own, so an admin cannot mint another admin.
- **Append-only audit log** with a `(tenant_id, created_at DESC)` index and keyset pagination, so the "recent activity" query stays O(limit) as the table grows.
- **No account enumeration.** Unknown email and wrong password return the same error.
- **Production-shaped from day one.** Multi-stage non-root images, health and readiness endpoints, graceful shutdown for rolling deploys, and migrations run on startup.

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

## Testing

```bash
npm test -w apps/api                       # unit + HTTP tests
INTEGRATION=1 npm test -w apps/api         # + Postgres integration tests
cd services/ai && pytest -q                # AI service
```

CI runs all three, with a real Postgres service container, then builds every Docker image.

## Roadmap

- [x] **Week 1 — Foundation:** monorepo, auth, multi-tenancy, RBAC, audit log, Docker, CI
- [ ] **Week 2 — RAG:** document upload, ingestion queue, embeddings in pgvector, hybrid search, cited answers, local LLM option
- [ ] **Week 3 — Analytics:** KPI dashboard, AI anomaly hints, Excel/PDF export
- [ ] **Week 4 — Ops:** Kubernetes manifests / Helm, Terraform, OpenTelemetry + Prometheus + Grafana, k6 load tests
- [ ] **Week 5 — Polish:** EN/RU/AR (RTL), Playwright e2e, RAG eval metrics, demo video

## Author

**Alhassan Alfarran** — Software & DevOps Engineer · [Portfolio](https://alhassan-portfolio-sigma.vercel.app/) · [GitHub](https://github.com/kyan9400)
