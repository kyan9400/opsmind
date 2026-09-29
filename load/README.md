# Load testing

[k6](https://k6.io) scripts that exercise the public API the way the web app does.

| Script | Profile | Purpose |
|---|---|---|
| `k6/smoke.js` | 1 VU, 30 s | Every key endpoint once per second with checks. Run it first: if this fails, the load numbers are meaningless. |
| `k6/load.js` | ramping VUs 0 → 20 → 50 → 0 over ~3 min | Latency budgets per endpoint under a realistic read-heavy mix. |
| `k6/lib.js` | – | Base URL, auth headers, tenant bootstrap and per-endpoint request helpers. |

Both scripts start by registering a **fresh tenant**, loading the 180-day demo KPIs, uploading a small text document and waiting until the worker has indexed it. Nothing depends on existing data, and repeated runs never interfere with each other. Setup requests are tagged `name=setup` and excluded from the per-endpoint numbers. The insights endpoint is called once during setup, so the run measures the Redis-cached path that users normally hit.

## Traffic mix (`load.js`)

| Endpoint | Share | p95 budget |
|---|---:|---:|
| `GET /metrics/dashboard?days=30&bucket=week` | 50% | 300 ms |
| `GET /metrics/insights?days=30` | 20% | 200 ms |
| `POST /ask` | 15% | 800 ms |
| `GET /documents` | 10% | 200 ms |
| `GET /auth/me` | 5% | 100 ms |

On top of the latency budgets, `http_req_failed` must stay below 1% across the whole run. Each VU waits 0.5–1.5 s between requests (think time).

## Running

Start the stack with the AI rate limit off, and run commands from the repo root, because results are written to `load/results/`:

```bash
AI_RATE_LIMIT=0 docker compose up -d --build --wait postgres redis api ai worker
```

The k6 scripts send every request with one token from one IP, so the per-user, per-IP AI limit (20 requests per minute by default, shared by ask, insights and report exports) would turn most insights and ask calls into 429s and fail the `http_req_failed` threshold. Each run registers only one tenant, well inside the login/register limit.

**With a local k6 binary:**

```bash
k6 run -e API=http://localhost:4000 load/k6/smoke.js
k6 run -e API=http://localhost:4000 load/k6/load.js                      # full ~3 min profile
k6 run -e API=http://localhost:4000 -e DURATION_SCALE=0.3 load/k6/load.js # ~1 min, as in CI
```

**With the `grafana/k6` image (no install):**

```bash
docker run --rm -i --network host -u "$(id -u):$(id -g)" -v "$PWD:/work" -w /work grafana/k6 \
  run -e API=http://localhost:4000 load/k6/load.js
```

`-u` runs k6 as your user, because the image's own user (uid 12345) cannot write the summary into a Linux bind mount you own. On Docker Desktop (macOS/Windows), `--network host` does not reach the host, so use `-e API=http://host.docker.internal:4000` instead.

| Variable | Default | Meaning |
|---|---|---|
| `API` | `http://localhost:4000` | API base URL |
| `DURATION_SCALE` | `1` | Multiplies every stage duration; the ramp shape stays the same |
| `RESULTS_DIR` | `load/results` | Where `summary.json` and `summary.md` are written (the directory must exist) |

**In CI:** the `load` job in `.github/workflows/ci.yml` starts the stack with Docker Compose (`AI_RATE_LIMIT=0`), runs `load.js` with `DURATION_SCALE=0.3`, adds the results table to the job summary and uploads `load/results/` as an artifact. The job fails only when a threshold fails (k6 exits with code 99).

## Reading results

`load.js` prints a table to stdout and writes it to `load/results/summary.md`. The raw k6 summary goes to `load/results/summary.json`.

| Column | Meaning |
|---|---|
| Requests | Requests sent to that endpoint during the run, excluding setup |
| p50 / p95 / p99 | Response-time percentiles. p95 is what the budget applies to, and p99 shows the tail. |
| p95 budget | The threshold for that endpoint |
| Error % | Non-2xx/3xx responses or transport errors for that endpoint |

Under the table, every threshold is listed as PASS or FAIL. A few things to keep in mind:

- **Shared CI runners are noisy.** Treat a single failing run near the budget as a signal to rerun, and a steady trend as a real regression. Compare against earlier runs using the uploaded artifacts.
- **`ask` is bounded by the AI service.** With the default `hash` embeddings and `extractive` answers it measures retrieval, not an LLM. Real providers need their own budget.
- **A high error rate with low latency** usually means requests were rejected fast, not that the API is quick. If the errors are on `insights` and `ask` only, they are almost certainly 429s from the AI rate limit: restart the API with `AI_RATE_LIMIT=0`. Otherwise look for 5xx from an overloaded dependency with `docker compose logs api ai worker`.
- If setup fails with `not indexed within 90s`, the worker is not consuming the queue, so check the worker before looking at API performance.
