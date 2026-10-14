# Raqib — backend

API, background worker and AI engine for Raqib (رقيب), an M&E platform for NGOs, INGOs and consultancies in Palestine and the region. The web app lives in [raqib-frontend](https://github.com/walidshalabi98/raqib-frontend).

Stack: Node 22 · TypeScript · Express 4 · Prisma 6 (PostgreSQL + pgvector, hosted on Supabase) · BullMQ + Redis · Anthropic SDK · Supabase Storage · Resend.

## Quick start

Requirements: Node 22, PostgreSQL 16 with the `vector` extension (or a Supabase project), and Redis if you run the worker.

```bash
npm ci
cp .env.example .env          # then fill in the values (see below)
npx prisma db push            # create the schema in your local database
npm run seed                  # demo organisation, users, projects, results chains and the indicator library (local only)
npm run dev                   # API on http://localhost:3001
```

Check it is running: `curl http://localhost:3001/api/health`.

Demo sign-in after seeding: `admin@momentumlabs.ps`, `me@momentumlabs.ps` or `donor@momentumlabs.ps`, password `admin123` (local development only). Anywhere else set `SEED_PASSWORD`: it must meet the password policy and becomes the org admin's password only; the admin then gives the other demo accounts their own one-time passwords in Settings → Team members → Reset password (`docs/SECURITY_SETUP.md` §9).

### Local database with Docker

```bash
docker run -d --name raqib-db -p 5432:5432 \
  -e POSTGRES_USER=raqib -e POSTGRES_PASSWORD=raqib -e POSTGRES_DB=raqib \
  pgvector/pgvector:pg16
# DATABASE_URL=postgresql://raqib:raqib@localhost:5432/raqib
# DIRECT_URL=postgresql://raqib:raqib@localhost:5432/raqib
```

### Environment

The server refuses to start if a required value is missing and lists what is wrong. Required:

| Variable | Notes |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | Postgres connection (Supabase: pooled URL and direct URL) |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | at least 32 characters each — `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | Claude API key |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | required in production for private document storage |

Optional AI settings (defaults in brackets):

| Variable | Notes |
|---|---|
| `AI_MODEL_MAIN` | model for long, careful work: frameworks, reports, assessments [`claude-sonnet-5-5`] |
| `AI_MODEL_FAST` | model for short tasks: document analysis, alternatives, qualitative coding, risk [`claude-haiku-5-5`] |
| `AI_REQUEST_TIMEOUT_MS` | timeout per AI request, at least 1000 [`60000`]; framework and report calls use longer ones |
| `AI_MAX_RETRIES` | retries after rate limits, overloads, server and network errors, 0–10 [`3`] |
| `AI_REFUSAL_FALLBACK` | `default`: a refused request is re-run on Anthropic's fallback model (Sonnet 5.5, Opus 5, Opus 5.5); `off`: refusals are errors [`default`] |
| `AI_CALL_RETENTION_MONTHS` | months an AiCall log row is kept, 1–120; the worker deletes older rows every night at 03:30 Asia/Hebron [`24`] |
| `VOYAGE_API_KEY` | embeddings for the indicator library; without it search uses keywords [empty] |
| `VOYAGE_MODEL` | Voyage embedding model [`voyage-4`] |

Optional email settings:

| Variable | Notes |
|---|---|
| `RESEND_API_KEY` | Resend key. Without it no email is sent: invites and admin password resets show the temporary password once to the admin, and forgot-password sends nothing. With it, invites, admin resets and forgot-password email a single-use link to choose a password (never a password), in English and Arabic (`docs/SECURITY_SETUP.md` §9) [empty] |
| `EMAIL_FROM` | sender on a domain verified in Resend [`Raqib by Momentum Labs <noreply@raqib.momentumlabs.ps>`] |

Everything else is optional and documented in `.env.example`. Security-related setup (storage bucket, webhook tokens, migrating old uploads, what is sent to AI providers) is in [`docs/SECURITY_SETUP.md`](docs/SECURITY_SETUP.md). The data model (Phase 2: results chain, indicator reference sheets, breakdowns, library; Phase 3: the AiCall log and Document.aiAnalysis) and the rollout steps for its SQL are in [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).

## AI layer

All model calls go through `src/services/ai/client.ts` (`generateStructured`): services pick a tier (`main` or `fast`), never a model id. Every call uses structured outputs validated again with zod, sends the shared system prompt (role + `knowledge/me-foundations.md` §1–12, prompt-cached), retries rate limits and server errors, retries a cut-off answer once, turns refusals into typed errors, and writes one `AiCall` row (tokens, latency, estimated cost; never prompt or answer text). Document text and qualitative notes are redacted (phone numbers, ID numbers, email addresses) before they are stored or sent; AiCall rows are deleted after 24 months. Details, prompt versions and privacy limits: [`docs/AI.md`](docs/AI.md).

**KPI Assistant (Phase 4).** `src/services/kpi/` suggests indicators for a project's results chain (`knowledge/kpi-assistant-spec.md` Part A): it builds a redacted project context, ranks indicator-library candidates (Voyage vectors when `VOYAGE_API_KEY` is set, keywords otherwise), asks the main tier (the fast tier for alternatives) for suggestions in batches of up to 4 results, and validates and scores every suggestion in code (no invented baselines or targets, no targets in names, donor caps, accountability indicators for humanitarian projects). Suggestions become cards the M&E officer accepts, edits or rejects; rejections teach the organisation's preferences. AI framework generation uses the same pipeline for its indicator step. The evaluation harness (`npm run eval:kpi`) runs `knowledge/kpi-eval-cases.json` through the same pipeline and checks the §A8 targets. The prompt is versioned `kpi-v2` (after the Phase 4 review fixes); the KPI routes are staff-only, and accepting an alternative can replace the indicator it stands for (`replaceSource`). See [`docs/AI.md`](docs/AI.md) §12.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API with auto-reload |
| `npm run worker` | BullMQ worker for background jobs (needs Redis) |
| `npm run build` | `prisma generate` + TypeScript compile; fails on any type error |
| `npm start` | run the compiled API from `dist/` |
| `npm run start:worker` | run the compiled worker from `dist/` (`dist/jobs/worker.js`; needs Redis) |
| `npm run lint` | ESLint |
| `npm run typecheck` | type-check source, tests, scripts and seed |
| `npm test` | Vitest unit and integration tests (see below) |
| `npm run seed` | reset and seed demo data — **deletes all data**, refuses to run in production; also loads the indicator library |
| `npm run seed:library` | load or update the indicator library from `knowledge/indicator-library.json` (idempotent, never deletes; safe in any environment; `-- path/to/draft.json` checks a draft file). With `VOYAGE_API_KEY` set, entries without an embedding are embedded (`VOYAGE_MODEL`, 1024 dimensions) and a second run embeds nothing; `-- --reembed` forces every entry to be re-embedded. Without the key it prints "Embeddings skipped". Needs only `DATABASE_URL` (plus `VOYAGE_API_KEY` / `VOYAGE_MODEL` to embed); entries whose vector is missing or was made by another model are embedded on a plain run |
| `npm run verify:migration` | prove the Phase 2, Phase 3 and Phase 4 SQL (`prisma/sql/2026-10-11_phase2_data_model.sql`, `prisma/sql/2026-10-12_phase3_ai_foundation.sql`, `prisma/sql/2026-10-12_phase4_kpi_assistant.sql`) and the Phase 0, 2, 3, 4 rollout order on throwaway local databases (needs git history and local Postgres with pgvector) |
| `npm run ai:smoke -- --yes` | **calls the real Anthropic API and costs money** (main tier: one call for the results chain when the project has parsed documents, then one per batch of up to 4 results for the indicators): generates a framework for the dev seed project (or `--project <id>`) on a development database and prints the indicators, the fields still to be confirmed and the AiCall rows. Needs a real `ANTHROPIC_API_KEY`; refuses in production and unless `DATABASE_URL` is local or names a `dev`/`test` database (`--i-know-this-is-not-shared` overrides); adds a framework version it never deletes. See [`docs/AI.md`](docs/AI.md) §10 |
| `npm run eval:kpi -- --fake` | KPI Assistant evaluation with a deterministic fake model: runs the 8 cases of `knowledge/kpi-eval-cases.json` through the real pipeline (retrieval, validation, assertions, metrics) with no key, no network and no database; free. Prints the summary table, saves `eval-results/<timestamp>.json` (git-ignored) and exits 0 only when the run is complete and every target passes (1 otherwise, 2 when it refuses). CI runs it after the tests. Options: `--case <id>` (repeatable), `--no-result-check`, `--out <dir>`, `--help` |
| `npm run eval:kpi -- --yes` | **calls the real Anthropic API and costs money** (about US$1–2 for all 8 cases; no new case starts once `--max-usd`, default 3, is spent): the same evaluation with the real model, to run after any prompt or library change and before release (spec §A8 targets: schema validity 100%, assertions ≥ 90%, library use ≥ 70%, no hallucinated targets, average quality ≥ 80, result-level calls with a median under 15 s and none over 30 s). `--embeddings` embeds the library in memory with Voyage (needs `VOYAGE_API_KEY`) to test the vector retrieval production uses with that key. Refuses without a real `ANTHROPIC_API_KEY`, without `--yes` and in production. It never uses a database: `DATABASE_URL` and `DIRECT_URL` are always replaced with an unusable placeholder and AiCall records stay in memory |
| `npm run storage:setup` | create the private Supabase Storage bucket |
| `npm run storage:migrate` | move pre-Phase-0 files from `uploads/` to private storage (dry run; add `-- --apply`) |
| `npm run ai-calls:prune` | shows the AiCall retention cutoff and how many rows are older (dry run); `-- --apply` deletes them in batches of 5000. Needs only `DATABASE_URL` (and optionally `AI_CALL_RETENTION_MONTHS`); prints numbers only. The worker does the same every night |
| `npm run redact:backfill` | one-off: removes phone numbers, ID numbers and email addresses from text stored before Phase 3 (`Document.parsedText`, string values of `Document.aiAnalysis`). Dry run with totals; `-- --apply` writes (take a backup first); `-- --include-qualitative` also existing qualitative entries (approved by the owner for the shared database); `-- --verbose` adds row ids. Needs only `DATABASE_URL` and the Phase 3 SQL; a second run changes nothing; prints totals and ids only. See [`docs/AI.md`](docs/AI.md) §9 |

## Tests

Unit tests run anywhere. Integration tests need a **disposable** Postgres database whose name contains `test` — every table in it is emptied.

```bash
export TEST_DATABASE_URL=postgresql://raqib:raqib@localhost:5432/raqib_test
DATABASE_URL=$TEST_DATABASE_URL DIRECT_URL=$TEST_DATABASE_URL npx prisma db push --skip-generate
npm test
```

Without `TEST_DATABASE_URL` the integration tests are skipped. AI calls are always mocked in tests (`tests/setup.ts` also points the SDK at an unreachable address, so an unmocked call fails at once); `npm run ai:smoke` and `npm run eval:kpi -- --yes` are the only commands that call the real API. `npm run eval:kpi -- --fake` needs no key and no database.

Every new route needs a role decision in `tests/roleMatrix.ts`, and every new `app.use` / `router.use` layer a review in `tests/roles.test.ts`: that test (no database) fails otherwise. A route open to donor viewers (`all` or `self`) also needs a request in `tests/donorAi.test.ts` (no donor request may reach an AI model) and, for a GET, in `tests/donorAccess.test.ts` (no personal data in the answer); their coverage tests fail otherwise. See [`docs/SECURITY_SETUP.md`](docs/SECURITY_SETUP.md) §8.

## KPI evaluation

The KPI Assistant evaluation runs the cases of `knowledge/kpi-eval-cases.json` through the real model and prints a summary table. It costs about US$1-2 for all 8 cases. CI runs it only with the free fake model; the real run is a button.

One-time setup (repository admin): GitHub → this repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, name `RAQIB_EVAL_ANTHROPIC_API_KEY`, value an Anthropic API key with a spending limit (the staging key is fine).

To run: **Actions** → **KPI evaluation (real model)** → **Run workflow**. Inputs:
- `ref`: the branch or commit to evaluate (it must contain `scripts/eval-kpi.ts`);
- `max_usd`: no new case starts once the spend reaches it (default 3, at most 10);
- `cases`: case ids separated by spaces, or blank for all.

The table appears on the run's summary page and the JSON report is kept as the `kpi-eval-results` artifact for 30 days. The workflow (`.github/workflows/kpi-eval.yml`) passes the key to the evaluation step only; the script uses no database and prints ids, counts and numbers only.

## Deploy

Node 22 or later (`engines` in `package.json`). One build serves two processes with the same environment (both validate it at start and exit with the list of problems):

- **API:** `npm run build`, then `npm start`. Behind one reverse proxy, with `NODE_ENV=production`. `JWT_SECRET` and `JWT_REFRESH_SECRET` must be two different values (the API refuses one value for both).
- **Worker:** the same build, then `npm run start:worker` (compiled JavaScript; `npm run worker` is the development command and needs `tsx`, a dev dependency). Needs `REDIS_URL`.

The build runs `prisma generate` and `tsc`, so install with dev dependencies (`npm ci --include=dev`, or `NPM_CONFIG_PRODUCTION=false` on hosts that install with `NODE_ENV=production`). The `knowledge/` folder must be deployed with `dist/`: the API reads the M&E rules and the indicator library from it at run time. Email can stay off at first (no `RESEND_API_KEY`): then temporary passwords are shown once to the admin who invites or resets a user, and nothing secret is written to the logs (`docs/SECURITY_SETUP.md` §9).

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on `main`: install, Prisma generate, lint, typecheck, tests against a pgvector Postgres service, the KPI evaluation with the fake model (`npm run eval:kpi -- --fake`), build and `npm audit --audit-level=high`. `.github/workflows/kpi-eval.yml` runs the real evaluation only on demand, with a spending cap (see [KPI evaluation](#kpi-evaluation)).

## Project layout

```
src/
  app.ts            Express app (middleware, routes)
  index.ts          starts the HTTP server
  config/           env validation, Prisma, Redis
  middleware/       auth, organisation access checks, rate limits, uploads, webhooks, errors
  routes/           REST endpoints
  services/ai/      AI client, prompts, redaction, embeddings and features (see docs/AI.md)
  services/kpi/     KPI Assistant: context, retrieval, model calls, validation, runs, accept/reject; eval/ is the evaluation harness
  services/library  indicator library loading, seeding and embedding
  services/storage  private file storage (Supabase / local)
  services/qualitative  redaction of qualitative entries when they are saved
  services/maintenance  AiCall retention and the stored-text backfill (run without the API environment)
  jobs/             BullMQ queues and worker
prisma/             schema, seed, reviewed SQL for shared databases
knowledge/          M&E rules, indicator library, KPI Assistant spec and eval cases
scripts/            one-off and maintenance commands (ai:smoke, eval:kpi, storage, backfills)
docs/               build guide and setup notes
tests/              Vitest + Supertest
```

## Working on Raqib

Read [`CLAUDE.md`](CLAUDE.md) and [`docs/BUILD_GUIDE.md`](docs/BUILD_GUIDE.md) first: they hold the rules (organisation isolation, no personal data to AI, reviewed migrations) and the phased plan.
