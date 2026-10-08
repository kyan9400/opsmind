# Live demo on Vercel + Neon (free, no bank card)

This guide puts the real OpsMind app online for free:

| Part | Where it runs | Plan |
| --- | --- | --- |
| web (Next.js) | Vercel project 1, folder `apps/web` | Hobby (free) |
| api (Express) | Vercel project 2, folder `apps/api` | Hobby (free) |
| ai (FastAPI) | Vercel project 3, folder `services/ai` | Hobby (free) |
| Postgres 16 + pgvector | Neon, AWS Frankfurt | Free |

Nothing here needs a bank card. The whole setup takes about 1–2 hours.

## How the live demo differs from Docker Compose

The live demo is the **serverless profile** of the same code. It is switched on only by the environment
variables below, so Docker Compose, Helm/kind and Codespaces run exactly as before.

- **No worker, no Redis.** With `INGEST_MODE=inline` the API indexes an uploaded document itself, right
  after it answers the upload (Vercel's `waitUntil`). It uses the same 3 attempts and 2 s / 4 s waits as the
  BullMQ worker. The full queue + worker + Redis setup still runs in Compose, Helm and Codespaces.
- **A daily job refreshes the demo.** Vercel Cron calls `GET /api/internal/cron/seed` once a day
  (`apps/api/vercel.json`). It moves the demo KPIs to "today", re-indexes any document that is not ready,
  and keeps the free database awake. Only a caller with the `CRON_SECRET` can run it.
- **Visitors can only look.** Sign-up is closed (`ALLOW_REGISTRATION=false`), visitors use the read-only
  demo login, uploads are limited to 4 MB, and `/metrics` is hidden (`METRICS_PUBLIC=false`).
- **Or they try their own data.** With `ALLOW_SANDBOX=true` (api) and `NEXT_PUBLIC_SANDBOX=true` (web),
  **Try it with your own data** gives each visitor a private workspace for 24 hours, with sample data and
  owner rights (upload, CSV import). Limits: 3 per IP per hour and 20 at once. Each one holds at most
  10 documents and 1 MB of files (512 KB per file) and 5,000 KPI points, and makes at most 20 uploads or
  imports per hour. When the database grows past 350 MB, new sandboxes and sandbox uploads stop (503)
  until it is smaller again, long before the free database reaches its 500 MB. After 24 hours
  the visitor's access ends; the data is deleted when the next visitor creates a sandbox, or by the daily
  job at the latest.
- **Cold starts.** After a quiet period the first click can take about 3–8 seconds. Nothing needs a manual wake-up.

## What you need

- Your GitHub account (the repository `kyan9400/opsmind`, with this code merged into `main`).
- A computer with Git Bash or PowerShell (to make 3 random passwords).
- A text file on your computer to keep notes. **Do not commit this file.**

---

## Step 1. Create the accounts

1. Open <https://vercel.com/signup>. Click **Continue with GitHub**. Choose **Hobby** ("personal projects").
   Vercel does not ask for a card on Hobby.
2. Open <https://console.neon.tech/signup>. Click **Continue with GitHub**. Neon Free does not ask for a card.

If a page does not open or keeps showing "Vercel Security Checkpoint", read
[If a website does not open from Russia](#if-a-website-does-not-open-from-russia).

## Step 2. Create the database (Neon)

> Neon not available in your region? Use Supabase instead: [SUPABASE.md](SUPABASE.md).

1. In Neon, create a new project:
   - **Project name:** `opsmind`
   - **Postgres version:** `16`
   - **Cloud provider:** `AWS`
   - **Region:** `AWS Europe Central 1 (Frankfurt)`. Do not choose an Azure region.
2. Make the database small, so the free hours last all month:
   - The branch menu at the top of the left sidebar shows **production**. A new project has only this
     one branch (there is no branch called `main`).
   - In the left sidebar, under **Postgres database**, click **Computes**, then **Edit**.
   - Set the compute size to **0.25 CU** for both minimum and maximum. Click **Save**.
3. Click **Connect** (top of the project page). You will copy **two** connection strings:
   - **Pooled:** "Connection pooling" switch **ON**. The host name contains `-pooler`.
     Save it in your notes as `POOLED_URL`.
   - **Direct:** "Connection pooling" switch **OFF**. The host name has **no** `-pooler`.
     Save it in your notes as `DIRECT_URL`.

   Both look like `postgresql://neondb_owner:...@ep-...eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`.
   Copy them exactly as shown.

## Step 3. Make three random passwords

Run one of these commands **three times**. Each run prints a new 64-character value.
Save them in your notes as `JWT_SECRET`, `AI_SERVICE_TOKEN` and `CRON_SECRET`.

Git Bash:

```bash
openssl rand -hex 32
```

PowerShell:

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

No website is needed. Never paste these values into a chat, an issue or a commit.

## Step 4. Vercel project 1: ai

1. In Vercel, click **Add New… → Project**.
2. Find `kyan9400/opsmind` and click **Import**. (First time: click **Install** to let Vercel read the repository.)
3. On the **Configure Project** page:
   - **Project Name:** `opsmind-ai`
   - **Root Directory:** click **Edit**, choose `services/ai`, click **Continue**.
   - **Framework Preset:** `FastAPI` (it is chosen automatically).
   - Do not change **Build and Output Settings**.
4. Open **Environment Variables** and add these (tip: you can paste all lines as `NAME=value` into the first
   **Key** field at once):

   | Name | Value | Where the value comes from |
   | --- | --- | --- |
   | `DATABASE_URL` | your `POOLED_URL` | Step 2 |
   | `AI_SERVICE_TOKEN` | your `AI_SERVICE_TOKEN` | Step 3 |
   | `DB_POOL_MAX` | `2` | type it |
   | `DB_POOL_CHECK` | `true` | type it |
   | `METRICS_PUBLIC` | `false` | type it |

5. Click **Deploy**. Wait until you see "Congratulations".
6. Click **Continue to Dashboard**. Under **Domains** you see the address, for example
   `opsmind-ai.vercel.app`. Save it in your notes as `AI_URL` with `https://` in front:
   `https://opsmind-ai.vercel.app`. Use this **Domains** address, not the long "Deployment" address.
7. Test it: open `AI_URL/health` in the browser. You should see `{"status":"ok","embed":"hash","llm":"extractive"}`.
   If you see a 500 error instead, read the first line of [Troubleshooting](#troubleshooting).

The region is Frankfurt (`fra1`); `services/ai/vercel.json` sets it.

## Step 5. Vercel project 2: api

1. **Add New… → Project** → import `kyan9400/opsmind` again.
2. On **Configure Project**:
   - **Project Name:** `opsmind-api`
   - **Root Directory:** `apps/api`
   - **Framework Preset:** `Express` (automatic). Do not change **Build and Output Settings**:
     `apps/api/vercel.json` already sets them.
3. **Environment Variables:**

   | Name | Value | Where the value comes from |
   | --- | --- | --- |
   | `DATABASE_URL` | your `POOLED_URL` | Step 2 |
   | `JWT_SECRET` | your `JWT_SECRET` | Step 3 |
   | `AI_SERVICE_URL` | your `AI_URL` | Step 4 |
   | `AI_SERVICE_TOKEN` | your `AI_SERVICE_TOKEN` (same as on ai) | Step 3 |
   | `CRON_SECRET` | your `CRON_SECRET` | Step 3 |
   | `INGEST_MODE` | `inline` | type it |
   | `DEMO_EMAIL` | `demo@opsmind.dev` | type it |
   | `DEMO_PASSWORD` | `opsmind-demo` | type it |
   | `ALLOW_REGISTRATION` | `false` | type it |
   | `METRICS_PUBLIC` | `false` | type it |
   | `MAX_UPLOAD_BYTES` | `4194304` | type it (4 MB) |
   | `PG_POOL_MAX` | `3` | type it |
   | `TRUST_PROXY` | `1` | type it |
   | `ALLOW_SANDBOX` | `true` | type it (turns on "Try it with your own data") |

   **Do not add `NODE_ENV`.** With `NODE_ENV=production`, Vercel skips the build tools and the build fails.
   **Do not add `REDIS_URL`.** The demo does not need Redis.

   The demo password is public on purpose: the login page shows it, and it only opens a read-only account.
4. Click **Deploy**. When it finishes, save the **Domains** address as `API_URL`, for example
   `https://opsmind-api.vercel.app`.
5. Test: `API_URL/health` shows `{"status":"ok"}`, and `API_URL/ready` shows `{"status":"ready"}`
   (the api can reach the database). A 500 error: see the first line of [Troubleshooting](#troubleshooting).

The region (Frankfurt) and the daily job are set in `apps/api/vercel.json`.

## Step 6. Fill the database (GitHub Actions, one time)

1. On GitHub open the repository → **Settings → Secrets and variables → Actions → New repository secret**.
   Add these secrets:

   | Name | Value |
   | --- | --- |
   | `NEON_DIRECT_URL` | your `DIRECT_URL` (the one **without** `-pooler`) |
   | `AI_SERVICE_URL` | your `AI_URL` |
   | `AI_SERVICE_TOKEN` | your `AI_SERVICE_TOKEN` |

   Optional: `DEMO_EMAIL` and `DEMO_PASSWORD`. Add them only if you changed them in Step 5. Without them
   the workflow uses `demo@opsmind.dev` / `opsmind-demo`.
2. Open **Actions** → **Demo database** (left list) → **Run workflow** → branch `main` → **Run workflow**.
3. Wait for the green check (about 2–3 minutes). The run summary says "Demo database ready".

The workflow creates the tables, the demo workspace (read-only login, 180 days of KPIs, 4 documents) and
indexes the documents through your ai project. You can run it again at any time; it is safe.

## Step 7. Vercel project 3: web

1. **Add New… → Project** → import `kyan9400/opsmind` again.
2. On **Configure Project**:
   - **Project Name:** `opsmind-demo` (this becomes the public address, so choose a nice name)
   - **Root Directory:** `apps/web`
   - **Framework Preset:** `Next.js` (automatic)
3. **Environment Variables:**

   | Name | Value | Where the value comes from |
   | --- | --- | --- |
   | `API_INTERNAL_URL` | your `API_URL` | Step 5 |
   | `NEXT_PUBLIC_API_URL` | `/` (one slash, nothing else) | it means "the same address as this web site" |
   | `NEXT_PUBLIC_DEMO_EMAIL` | `demo@opsmind.dev` | same as `DEMO_EMAIL` on api |
   | `NEXT_PUBLIC_DEMO_PASSWORD` | `opsmind-demo` | same as `DEMO_PASSWORD` on api |
   | `NEXT_PUBLIC_SANDBOX` | `true` | shows the sandbox button; only together with `ALLOW_SANDBOX=true` on api |

   Why: the browser talks only to the web address, and the web server passes every `/api/...` call to the
   api project. So no other address is needed in the browser.
4. Click **Deploy**.
5. Open **Settings → Functions → Function Region**, choose **Frankfurt, Germany (fra1)**, save, and
   **Redeploy** once more.

## Step 8. Test the live demo

Open these addresses (replace with yours):

| Address | Expected result |
| --- | --- |
| `https://opsmind-demo.vercel.app` | The start page. Click **Try the live demo**. You land on the analytics dashboard. |
| Ask page, question "How many days do customers have to request a refund?" | An answer with "30 days" and a source. Then ask "And after 30 days?": the second answer follows on from the first. |
| Start page → **Try it with your own data** | The Documents page of a new workspace with a "deleted in 23 hours" bar. The 4 sample files become **ready** within a minute; upload a small `.txt` and ask about it. |
| `API_URL/health` | `{"status":"ok"}` |
| `API_URL/ready` | `{"status":"ready"}` |
| `API_URL/metrics` | `{"error":"not found"}` (hidden on purpose) |
| `AI_URL/metrics` | `{"detail":"Not Found"}` (hidden on purpose) |

Also test from a Russian home network, from mobile internet without VPN, and from abroad
(for example with <https://check-host.net> → "HTTP" check).

Check the daily job: in the api project open **Settings → Cron Jobs**. You see
`/api/internal/cron/seed`, once a day around 03:00 UTC. **View Logs** shows each run.

## Optional: real LLM answers (free tier, for example Groq)

Without this step the demo answers with `extractive` mode: the best-matching source sentences, cited.
To let a model write the answers, use any OpenAI-compatible endpoint. Groq, OpenRouter and Together all
have free tiers.

1. Create an API key with your provider (Groq: <https://console.groq.com/keys>). Save it in your notes.
2. In Vercel open the **ai** project (`opsmind-ai`) → **Settings → Environment Variables** and add:

   | Name | Value (Groq example) | Notes |
   | --- | --- | --- |
   | `LLM_PROVIDER` | `openai-compatible` | |
   | `LLM_BASE_URL` | `https://api.groq.com/openai/v1` | the part before `/chat/completions` |
   | `LLM_API_KEY` | your key | secret |
   | `LLM_MODEL` | a chat model your provider lists, e.g. `llama-3.1-8b-instant` | |
   | `LLM_TIMEOUT_S` | `30` | optional, seconds; this is the default |
   | `LLM_MAX_TOKENS` | `400` | optional, answer length limit; this is the default |

   **The key goes only into the ai project.** The api and web projects never call the model and must not
   get `LLM_API_KEY`. Never commit the key or paste it into an issue or chat.
3. **Redeploy** the ai project. `AI_URL/health` now shows `"llm":"openai-compatible"`.

If the provider fails, times out or hits its free-tier rate limit, the question still gets an answer: the
ai service falls back to the extractive answer and reports `"provider": "extractive-fallback"`. The
analytics summary falls back to its template the same way. So a used-up free quota never breaks the demo.

## Everyday use

- Every push to `main` redeploys all three projects automatically. To save builds, in each project open
  **Settings → Build and Deployment → Root Directory** and turn on
  **"Skip deployments when there are no changes to the root directory or its dependencies"**.
- After you change an environment variable, **Redeploy** that project. Old deployments keep the old values.
- **When an update adds a database migration** (a new file in `apps/api/migrations/`): Vercel does not
  run migrations, so run **Actions → Demo database → Run workflow** and pick the **pull request's branch**,
  before you merge. Migrations only add things, so the running version keeps working, and the new one
  finds its tables ready. The sandbox update adds `004_sandbox.sql`; without it, every page after sign-in
  fails with an error.
- Put the web address in your CV. Add the SourceCraft "interactive preview" link as a backup for people
  whose network cannot open `vercel.app`.

## If a website does not open from Russia

Some Russian networks have trouble with Vercel and Cloudflare sites (September 2026: Vercel knows about
it and has no fix yet).

- **Vercel dashboard hangs on "Vercel Security Checkpoint":** wait 30 seconds and reload once. If it still
  hangs, use another network (mobile internet instead of home Wi-Fi, or the other way round), another
  browser, or a VPN only for the setup. You need the dashboard only for setup and changes.
- **Neon console does not load:** same advice. After Step 2 you do not need the Neon console again,
  unless you want to look at usage.
- **The demo itself (`*.vercel.app`) does not open for a visitor:** you cannot fix this from your side.
  Give that visitor the SourceCraft preview link or the Codespaces button in the main README.
- GitHub Actions runs outside Russia, so Step 6 always works, even when your own network has problems.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `API_URL/health` or `AI_URL/health` shows **500** and `FUNCTION_INVOCATION_FAILED` | An environment variable is missing or wrong, so the service stops before it can answer. Open that project → **Logs**. The first red error names the variable, for example: `JWT_SECRET`, `AI_SERVICE_TOKEN` or `CRON_SECRET` shorter than 16 characters; `DATABASE_URL` missing; `ALLOW_REGISTRATION`, `METRICS_PUBLIC` or `DB_POOL_CHECK` not `true` or `false`; a number setting that is not a number. Fix it in **Settings → Environment Variables**, then **Redeploy**. |
| api build error `INVALID_CRON_SECRET` | `CRON_SECRET` has a space or a line break before or after it. Paste the value again with nothing around it, then **Redeploy**. |
| api build error: "No entrypoint found" | Root Directory must be `apps/api`. Build and Output Settings must be default (no overrides). |
| api build error about `tsc` / TypeScript | Remove `NODE_ENV` from the api environment variables. Redeploy. |
| ai build installs nothing, or `ModuleNotFoundError: fastapi` | Root Directory must be `services/ai`. Framework Preset `FastAPI`. |
| `API_URL/ready` shows `db unavailable` | `DATABASE_URL` on api is wrong (use the pooled one, copied exactly), then **Redeploy** api. |
| Workflow fails at **Check the repository secrets** | Read the red message. Add the missing secret. `NEON_DIRECT_URL` must be the one **without** `-pooler`. |
| Workflow fails at **The AI service answers** | `AI_SERVICE_URL` must be the ai **Domains** address (`https://...vercel.app`), not a deployment address. Open it + `/health` in a browser. |
| Workflow fails at **Seed the demo workspace**: "documentsFailed" | `AI_SERVICE_TOKEN` differs between GitHub, api and ai. Make all three the same, redeploy ai and api, run the workflow again. |
| "Try the live demo" says "invalid credentials" | Run the workflow (Step 6). `DEMO_EMAIL`/`DEMO_PASSWORD` on api must equal `NEXT_PUBLIC_DEMO_EMAIL`/`NEXT_PUBLIC_DEMO_PASSWORD` on web. |
| The web page loads, but every action fails with a network error | `NEXT_PUBLIC_API_URL` or `API_INTERNAL_URL` on web is wrong or missing. Fix it, then **Redeploy** web (these values are fixed at build time). |
| Documents stay "queued" or "failed" | Run the workflow again; it re-indexes them. The daily job also retries them. |
| Answers or insights show "AI service unavailable" | Open `AI_URL/health`. If it fails, open the ai project → **Logs**. Check `DATABASE_URL` on ai. |
| "too many attempts" for every visitor | All visitors may reach the api through the web server's address. Add `AUTH_RATE_LIMIT` = `100` on api and redeploy. |
| Upload says 413 | Files over 4 MB are refused on the live demo (Vercel accepts at most 4.5 MB per request). In a sandbox the limits are 512 KB per file and 1 MB in total. |
| Sandbox button or sandbox upload says the demo database is nearly full (503) | The database is over 350 MB (`SANDBOX_DB_BRAKE_BYTES`). Check **Supabase → Reports → Database**. Expired sandboxes are deleted automatically, and new data reuses their space, but the size Supabase shows only goes down after a `VACUUM FULL` of the big tables (`chunks`, `documents`) in the SQL Editor. The read-only demo login keeps working the whole time. |
| Sign-up says "registration is disabled" | Expected on the live demo. |
| First click after a long pause is slow | Expected (3–8 seconds): the functions and the database wake up. |
| Vercel email "usage limit reached" | The free plan stops until the next 30-day period. Usually this means bots. Check **Usage** in Vercel. |
| Neon email "compute suspended" / out of hours | Check that the compute is 0.25 CU (Step 2). It starts again next month. |

## Free-plan limits (checked September 2026)

- Vercel Hobby: 1,000,000 function calls and 4 hours of active CPU per month, 300 s per request,
  4.5 MB per request body, one function region, cron at most once a day.
  <https://vercel.com/docs/plans/hobby>
- Neon Free: 100 compute hours per month (0.25 CU runs about 400 hours), 0.5 GB storage, 5 GB transfer.
  The database sleeps after 5 minutes without queries and wakes in well under a second.
  <https://neon.com/docs/introduction/plans>

## Reference: every setting of the serverless profile

| Variable | Service | Default (Compose/Helm) | Live demo | Meaning |
| --- | --- | --- | --- | --- |
| `INGEST_MODE` | api | `queue` | `inline` | Index uploads in the API process instead of a BullMQ worker. |
| `REDIS_URL` | api | `redis://localhost:6379` (queue mode) | unset | Inline mode runs without Redis (no insights cache). |
| `PG_POOL_MAX` | api | `10` | `3` | Postgres connections per instance. |
| `MAX_UPLOAD_BYTES` | api | `10485760` | `4194304` | Largest upload. |
| `ALLOW_REGISTRATION` | api | `true` | `false` | `false`: sign-up answers 403. |
| `METRICS_PUBLIC` | api, ai | `true` | `false` | `false`: `/metrics` answers 404. |
| `CRON_SECRET` | api | unset | random | Enables `/api/internal/cron/seed` for `Authorization: Bearer <secret>`. |
| `DEMO_EMAIL`, `DEMO_PASSWORD` | api | unset | demo login | Used by the daily seed. |
| `ALLOW_SANDBOX` | api | `false` | `true` | `true`: `POST /api/v1/sandbox` creates 24-hour private workspaces. Expired ones are deleted when the next one is created (10 at a time) and by the daily job. |
| `SANDBOX_RATE_LIMIT` | api | `3` | `3` | Sandboxes per IP per hour (per instance); `0` disables the limit. |
| `SANDBOX_MAX_ACTIVE` | api | `20` | `20` | Live sandboxes at once, across all instances. |
| `SANDBOX_MAX_DOCUMENTS` | api | `10` | `10` | Documents per sandbox, the 4 samples included. |
| `SANDBOX_MAX_BYTES` | api | `1048576` | `1048576` | Total size of a sandbox's files (1 MB), samples included. More is refused with 413. |
| `SANDBOX_MAX_FILE_BYTES` | api | `524288` | `524288` | Largest file a sandbox can upload, document or CSV (512 KB). |
| `SANDBOX_MAX_CSV_ROWS` | api | `5000` | `5000` | KPI data points a sandbox can hold in total, over all imports (the samples are 1,080). |
| `SANDBOX_WRITE_RATE_LIMIT` | api | `20` | `20` | Uploads, re-indexes, CSV imports and demo loads per sandbox per hour, counted in the database too; `0` disables. |
| `SANDBOX_DB_BRAKE_BYTES` | api | `367001600` | `367001600` | Above this database size (350 MB) new sandboxes and sandbox writes get 503. Checked once a minute per instance; `0` disables. |
| `NEXT_PUBLIC_SANDBOX` | web | unset | `true` | Shows **Try it with your own data** (build time). Pair with `ALLOW_SANDBOX=true`. |
| `DB_POOL_MAX` | ai | `10` | `2` | Postgres connections per instance. |
| `DB_POOL_CHECK` | ai | `false` | `true` | Test each connection before use (instances freeze between requests). |

Files: `apps/api/vercel.json` (Express preset, `dist/` entry, Frankfurt, daily cron, PDF fonts),
`services/ai/vercel.json` and `services/ai/index.py` (FastAPI entry, Frankfurt),
`.github/workflows/demo-db.yml` (migrations + seed). The ai service keeps its lint and test settings in
`ruff.toml` and `pytest.ini`, because Vercel would read a `pyproject.toml` as the dependency list instead
of `requirements.txt`.
