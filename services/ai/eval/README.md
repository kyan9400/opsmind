# Retrieval-quality evaluation

Measures how well `/v1/ask` finds the right document, and whether hybrid search (vector + full text, fused with Reciprocal Rank Fusion) earns its complexity over either retriever alone.

## Dataset

`dataset/docs/` holds 12 short policy documents of a fictional smart-home retailer, Volga Home (devices plus the Volga Cloud subscription):

| Document | Language | Topic |
|---|---|---|
| `refund_policy.md` | en | device returns, subscription refunds, form RF-2, chargebacks |
| `shipping_policy.md` | en | dispatch cut-off, express `SHP-EXP`, damaged and lost parcels |
| `hr_leave_policy.md` | en | annual leave, forms HR-12 / HR-21, carry-over |
| `expense_policy.md` | en | approval limits, form EXP-204, per diem, corporate cards |
| `incident_runbook.md` | en | SEV levels, status page cadence, runbooks RB-7 / RB-9 / RB-12 |
| `security_policy.md` | en | MFA, lost devices, phishing, data classification |
| `onboarding.md` | en | first day and week, buddy, probation check-ins |
| `pricing.md` | en | device codes (TH-100, LS-20, HUB-2, SK-1), cloud plans, discounts |
| `sla.md` | en | availability commitments, service credits, response times |
| `remote_work_ru.md` | ru | hybrid schedule, working from abroad, form УД-5 |
| `warehouse_safety_ru.md` | ru | safety induction, lifting limits, accident form Н-1 |
| `customer_support_ar.md` | ar | support channels, hours, escalation, warranty claims |

The documents deliberately share vocabulary (several `POL-FIN-*` codes, "30 days" and "14 days" in several documents, "Volga Cloud" in five), so a retriever cannot win on one rare word.

`dataset/questions.jsonl` has 56 questions, one JSON object per line:

```json
{"question": "POL-FIN-05", "expected_doc": "expense_policy.md", "lang": "en", "kind": "exact"}
```

| `kind` | What it tests | Example |
|---|---|---|
| `exact` | codes, IDs, product names, typed as a search-box query | `RB-7 failover`, `форма УД-5` |
| `natural` | a full question that reuses the document's wording | "How long does a card refund take?" |
| `paraphrase` | same meaning, different words | "Can I take a cab home late at night on the company?" (doc: *taxi is reimbursed between 22:00 and 06:00*) |
| `crosslingual` | question and document in different languages | "How many days a year can I work from abroad?" → Russian doc |

`lang` is the language of the question (en, ru, ar).

## Metrics

Each question is run in three modes of the production `hybrid_search` (`app/retrieval.py`):

- `vector`: pgvector cosine ranking only
- `fts`: Postgres full text only: `to_tsquery('simple', …)` built from an OR of the question's content words (EN/RU/AR stop words dropped, at most 16 terms), ranked by `ts_rank_cd`
- `hybrid`: both, fused with RRF (k = 60), the production default

Ranking is at document level: the top 10 chunks are fetched and a document ranks where its best chunk ranks.

- **Recall@k** (k = 1, 3, 5): share of questions whose expected document is in the top k. Recall@5 matters most, because `/v1/ask` passes 5 chunks to the LLM by default.
- **MRR@10**: mean of 1 / rank of the expected document, or 0 when it is not in the top 10. It rewards putting the right document first, not just somewhere in the context.

Results are broken down by `kind` and by `lang`, and the report lists every question hybrid misses at 5.

## Running it

It needs a Postgres with pgvector and the app schema (the API's migrations), because retrieval is SQL:

```bash
# from the repo root; the URL is the docker compose / .env.example default
export DATABASE_URL=postgres://opsmind:opsmind_dev_password@localhost:5432/opsmind
JWT_SECRET=dev-secret-at-least-16 npm run migrate -w apps/api   # apply the schema

cd services/ai
python -m eval.run_eval --out eval/results.md --min-recall 0.8
```

The script creates a throwaway tenant, uploads every document as a `documents` row and indexes it through `POST /v1/ingest` (the production extract → chunk → embed → insert path), embeds each question with the configured provider as `/v1/ask` does, and deletes the tenant at the end (documents and chunks cascade).

Outputs: a markdown report on stdout and in `--out`, and the full per-question ranks in JSON (`--json`, default: `--out` with `.json`). The exit code is 1 when hybrid Recall@5 is below `--min-recall`, so CI catches retrieval regressions such as a broken full-text leg, a chunking change or a fusion bug.

The dataset and metric helpers are unit-tested without a database in `tests/test_eval_metrics.py`; the retrieval modes are tested in `tests/test_retrieval_modes.py`.

## Reading the numbers

The default embedder is `hash`: deterministic feature hashing of words and word pairs, with no model. It is **lexical**, so on this setup "vector" search is really a bag-of-words retriever.

Results from CI with `hash` (Recall@5 / MRR@10 by question kind):

| Kind | n | vector | fts | hybrid |
|---|---:|---:|---:|---:|
| exact | 19 | 100.0% / 0.86 | 89.5% / 0.77 | 89.5% / 0.89 |
| natural | 18 | 100.0% / 0.81 | 100.0% / 1.00 | 100.0% / 0.94 |
| paraphrase | 13 | 76.9% / 0.47 | 76.9% / 0.54 | 84.6% / 0.65 |
| crosslingual | 6 | 33.3% / 0.08 | 0.0% / 0.00 | 33.3% / 0.07 |
| **all** | 56 | 87.5% / 0.668 | 80.4% / 0.710 | 85.7% / 0.763 |

- **exact**: the vector leg finds every code in the top 5, but hash collisions and long chunks let other documents that share a token (`pol`, `fin`, `1`) outrank it. Full text matches the code exactly, so fusion puts the right document first more often (the best MRR, 0.89). Hybrid misses two lookups that vector alone finds, an email address and a short Cyrillic code (`ОТ-7`): documents that full text also returns overtake them in the fusion.
- **natural**: solved by every mode. Full text ranks them best now that it ORs the question's content words; the earlier `websearch_to_tsquery` query ANDed every word, including "how", "does" and "a", and matched almost none of these questions.
- **paraphrase**: partly solved. Most paraphrases still share a content word with the document, so each retriever alone finds 10 of 13 and fusion finds 11. The two misses reword the key terms ("cab" for *taxi*; "bulk discount on hardware" for *50 or more devices*), which a lexical retriever cannot bridge.
- **crosslingual**: the weak spot. A question in one language shares almost no words with a document in another, so full text finds none and the hash vectors find 2 of 6. This is the gap a multilingual embedding model closes.

With `EMBED_PROVIDER=openai` (`text-embedding-3-small`) or `EMBED_PROVIDER=ollama`, the vector leg becomes semantic, so paraphrases should improve. Cross-language questions also need a multilingual model: `text-embedding-3-small` is one, but Ollama's default `nomic-embed-text` is English-centric, so set `OLLAMA_EMBED_MODEL` to a multilingual model with 768-dimensional vectors (the schema's size). Those providers have not been run against this dataset, so no numbers are claimed for them. To measure them, run the same command with the provider configured; the threshold was calibrated for `hash`.

```bash
EMBED_PROVIDER=openai OPENAI_API_KEY=... python -m eval.run_eval --out eval/results-openai.md
```

## Adding questions

Append a line to `questions.jsonl`. `expected_doc` must be an existing file in `dataset/docs/` and `kind` one of the four above; the loader rejects anything else, so a typo cannot quietly count as a miss. Write the question the way a user would, and do not tune it until it passes: failures are the useful part of the report.
