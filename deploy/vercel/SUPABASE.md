# Using Supabase instead of Neon

Neon blocks some regions ("Access Blocked in Your Region"). Supabase Free works the same way for this
demo: Postgres with pgvector, no card. Follow [README.md](README.md) and replace **Step 2** with the
steps below. Everything else stays the same.

## Step 2 (Supabase). Create the database

1. Open <https://supabase.com/dashboard> and sign in with GitHub. Use the free plan.
2. Open your project (or **New project**: any name, a region in Europe, a strong database password).
3. If you do not know the database password: **Project Settings → Database → Reset database password**.
   Save it in your notes as `DB_PASSWORD`.
4. Click **Connect** (top of the project page). You need **two** connection strings. In each one,
   replace `[YOUR-PASSWORD]` with your `DB_PASSWORD`.
   - **Transaction pooler** (port **6543**): save as `POOLED_URL`.
   - **Session pooler** (port **5432**): save as `DIRECT_URL`.

   Do not use the "Direct connection" string: on the free plan it only works over IPv6, which
   GitHub Actions does not have.
5. Add the SSL settings to the end of each string:
   - For the **api** project: add `?sslmode=require&uselibpqcompat=true` to `POOLED_URL`.
   - For the **ai** project: add `?sslmode=require` to `POOLED_URL`.
   - For the GitHub secret `DATABASE_DIRECT_URL`: add `?sslmode=require&uselibpqcompat=true` to `DIRECT_URL`.

   These encrypt the connection. Supabase signs its certificates with its own authority, so the
   stricter "verify" modes would reject them.

## Differences in the later steps

| Where | Change |
| --- | --- |
| Step 4 (ai) | Also add `DB_PREPARED_STATEMENTS` = `false`. The transaction pooler cannot keep prepared statements. |
| Step 6 (GitHub secrets) | Name the secret `DATABASE_DIRECT_URL` (the old name `NEON_DIRECT_URL` also works). Value: the **Session pooler** string with `?sslmode=require&uselibpqcompat=true`. |

## Good to know

- Supabase pauses a free project after 7 days without activity. The daily Vercel cron job keeps it
  awake. If it was paused anyway, click **Restore project** in the dashboard.
- The free database holds 500 MB; the demo uses a few MB.

## Common mistakes

| Symptom | Cause and fix |
| --- | --- |
| api returns `500 FUNCTION_INVOCATION_FAILED` on every page, and its logs are empty | The api stops at startup when a setting is invalid. Most often `DATABASE_URL` is "not a valid URL". |
| `DATABASE_URL` is "not a valid URL" | The value was pasted with quote marks around it, or the database password contains `@`, `#`, `/`, `?`, `:` or `%`. Remove the quotes. Write special characters in the password URL-encoded: `@` → `%40`, `#` → `%23`, `/` → `%2F`, `?` → `%3F`, `:` → `%3A`, `%` → `%25`. Or reset the password to one with letters and digits only. |
| `gh secret set -f file.env` fails with "unexpected character" | The env-file reader rejects some values. Set each secret on its own instead: `Get-Content -Raw value.txt \| gh secret set NAME -R <owner>/<repo>` (PowerShell) or `gh secret set NAME < value.txt` (bash). |
| A secret value appeared in an error message you shared | Replace it: make a new random value, update it everywhere it is used (Vercel projects and GitHub secrets), then redeploy. |
