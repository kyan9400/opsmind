# Interactive preview on SourceCraft Sites

The **interactive preview** is the OpsMind web UI as plain static files. It uses data recorded from the
real system, and there is no server behind it. A yellow banner on every page says this and links to
GitHub Codespaces, where the full system runs. SourceCraft Sites (Yandex) hosts it for free and it
opens from Russia.

GitHub Actions does the work: the **Preview** workflow (`.github/workflows/preview.yml`) starts the full
stack, records the demo workspace, builds the site, tests it in a browser and publishes it. You only set
it up once.

## Set it up (once, about 20 minutes)

Do steps 1–5 **before** you merge the pull request with the preview into `main`. Then the first run
after the merge publishes the site by itself.

1. Open <https://sourcecraft.dev> and sign in with your **Yandex ID**.
2. Create an **organization** and make it **public**. Sites only work for a public repository in a
   public organization. Write down the organization **slug**: it is the part after
   `sourcecraft.dev/` in the address bar, for example `kyan`.
3. In that organization, create a **public repository** named `opsmind` (lowercase). Create it
   **empty**: do not add a README or a template. (If it already has files, that is OK too.)
4. Create a **personal access token** (PAT) in your SourceCraft profile settings. Give it access to
   the `opsmind` repository with a role that can **push** (write). Copy the token now; you cannot see
   it again.
5. On GitHub, open the OpsMind repository, then **Settings → Secrets and variables → Actions**:
   - **Secrets** tab → **New repository secret**: name `SOURCECRAFT_TOKEN`, value = the token.
   - **Variables** tab → **New repository variable**: name `SOURCECRAFT_REPO`, value =
     `<organization slug>/opsmind`, for example `kyan/opsmind`.
6. Merge the pull request into `main`. The merge starts the **Preview** workflow by itself: open
   **Actions → Preview** and wait until the run is green (about 10 minutes). The workflow is listed in
   **Actions** only after it is on `main`. To run it again later: **Actions → Preview → Run workflow**
   (branch `main`).
7. Open the finished run. The summary shows the address:
   `https://<organization slug>.sourcecraft.site/opsmind/`. The first time, SourceCraft needs **a few
   minutes** before the page appears.
8. Test the address:
   - from Russia: home Wi-Fi **without VPN**, and mobile internet;
   - from abroad: <https://check-host.net> → "HTTP" check with the address.

   You should see the yellow banner. **Open the demo workspace** shows 6 KPI cards, **Ask AI**
   answers the example questions, and **AR** switches the page to right-to-left.
9. In your CV, call it **"Interactive preview (recorded data)"**, never "live demo".

After this, every push to `main` records fresh data and publishes again. You do nothing.

## How it works

- `scripts/record-preview.mjs` signs in as the read-only demo viewer and saves every API answer the UI
  needs into `apps/web/preview-data/` (plus the Excel and PDF reports). The files are made fresh in CI
  and are not in git.
- The demo documents are in English, and CI records without an AI model (the answer quotes the
  documents). So in Russian and Arabic, an example question shows the recorded answer to its English
  version, and the page says so.
- The build uses `STATIC_PREVIEW=1 NEXT_PUBLIC_PREVIEW=1 PREVIEW_BASE_PATH=/opsmind`. The browser
  answers from the saved files; it never calls a server. Dates move forward so the last recorded day
  is today; the values stay as recorded.
- The workflow has two jobs. **preview** builds and tests the site and has no secrets. **publish** runs
  only on `main`, takes the tested site from the artifact and runs `deploy/sourcecraft/publish.sh`.
  Only this job sees the token, and the token is sent only to `git.sourcecraft.dev`.
- `publish.sh` pushes the site to the branch `site` of your SourceCraft repository (one new commit each
  time). The default branch (usually `main`) keeps `.sourcecraft/sites.yaml`, which tells SourceCraft
  to publish the branch `site`.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| There is no **Preview** workflow in **Actions** | The pull request is not merged into `main` yet (step 6). |
| The **publish** step says **"SourceCraft publish skipped"** | The secret or the variable is missing or misspelled (step 5). Fix it, then **Run workflow**. The built site is still in the run's **interactive-preview** artifact. |
| The **publish** job is grey (skipped) | The run was not on `main`. Only `main` is published. |
| **Authentication failed** or **403** in the publish step | The token expired or cannot push. Create a new token (step 4) and replace the secret. |
| **rejected** / **protected branch** when pushing `site` | In the SourceCraft repository settings, allow force-push to the branch `site`, or remove the branch rule. |
| The address shows **404** | Wait 5 minutes. Check that the organization and the repository are both **public**, and that the repository name is exactly the part after `/` in `SOURCECRAFT_REPO`. Open the repository on sourcecraft.dev: its default branch must have the file `.sourcecraft/sites.yaml`. If the default branch is another one, run the workflow again (it writes the file to the default branch). |
| The page is white or has no styles | The repository was renamed. Update `SOURCECRAFT_REPO` and run the workflow again: the site is built for the path `/<repository>/`. |
| The start page works, but a direct link to an inner page shows 404 | Open the start page and use the menu. Tell the developer: the host did not serve that folder's `index.html`. |
| **429 Too Many Requests** | SourceCraft limits many fast requests. Wait a few seconds and reload. |
| The **record** step fails (documents not ready, no KPIs, or "cites no demo document") | Run the workflow again. If it fails again, open the log of the failed run and send it to the developer. |

## Try it on your computer (optional)

With Docker running (or in GitHub Codespaces):

```bash
docker compose up -d --build --wait postgres redis api ai worker
docker compose exec -T -e DEMO_EMAIL=demo@opsmind.dev -e DEMO_PASSWORD=opsmind-demo api node dist/seedDemo.js
DEMO_PASSWORD=opsmind-demo node scripts/record-preview.mjs
STATIC_PREVIEW=1 NEXT_PUBLIC_PREVIEW=1 PREVIEW_BASE_PATH=/opsmind npm run build -w apps/web
PREVIEW_BASE_PATH=/opsmind SERVE_ONLY=1 node apps/web/preview-smoke.mjs   # then open http://127.0.0.1:4173/opsmind/
```

**On Windows (Git Bash)**, put `MSYS_NO_PATHCONV=1` in front of the last two commands, for example
`MSYS_NO_PATHCONV=1 STATIC_PREVIEW=1 NEXT_PUBLIC_PREVIEW=1 PREVIEW_BASE_PATH=/opsmind npm run build -w apps/web`.
Without it, Git Bash changes `/opsmind` into a Windows folder path and the build stops with an error.

Without `SERVE_ONLY=1`, the last command runs the browser smoke test instead (it needs
`npx playwright install chromium` once).
