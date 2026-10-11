# Raqib — Build Guide for Claude Code

Version 1.0 · 11 October 2026 · Prepared for Walid Shalabi

This guide tells Claude Code how to take Raqib from its current state to a product that M&E teams can pilot: stable, secure, pleasant to use, and "active" — it suggests the right KPIs for each project and keeps watching the project afterwards. Copy the same file into both repositories (`raqib-backend/docs/BUILD_GUIDE.md` and `raqib-frontend/docs/BUILD_GUIDE.md`).

Companion files (backend repo, `knowledge/` folder):

| File | What it is |
|---|---|
| `knowledge/me-foundations.md` | M&E rules and standards the product and the AI must follow (with sources) |
| `knowledge/indicator-library.json` | 63 seed indicators across 11 sectors, aligned with EU GERF, Sphere, WFP, JMP, IASC MHPSS, CHS where applicable, with Arabic names |
| `knowledge/kpi-assistant-spec.md` | Full specification of the KPI Assistant and the Active Monitoring engine |
| `knowledge/kpi-eval-cases.json` | Eight realistic Palestinian test projects with pass/fail assertions for the AI |

---

## 0. How to use this guide

**For Walid.** Put the files in place (see the delivery note at the end), open Claude Code in the backend folder, and start each working session with the phase prompt from §9. Work one phase at a time. Each phase ends with a pull request you review and merge. Do not skip Phase 0 and Phase 1: the later phases depend on them.

**For Claude Code.**

1. Read `CLAUDE.md`, this guide and the relevant `knowledge/` files before changing code.
2. Use plan mode for every phase: write the plan, list the files you will touch, then implement.
3. One phase = one branch (`phase-N-short-name`) = one pull request. Keep commits small and descriptive.
4. Each phase has acceptance criteria. Do not mark a phase done until every criterion passes and the checks in §7 pass.
5. Ask before anything destructive: dropping columns or tables, deleting data, changing auth, rotating secrets, or running migrations against a shared database.
6. Never commit secrets. Never send beneficiary personal data to an AI model.
7. When this guide and the code disagree, trust the code for *what exists* and this guide for *what should exist*; note the difference in the PR description.

---

## 1. Product vision

**Raqib (رقيب) is an M&E co-pilot for NGOs, INGOs and consultancies working in Palestine and the region.** It turns a proposal into a donor-ready results framework, suggests the right indicators, tracks data against targets, and tells the team what needs attention before the donor asks.

**Who uses it**

- **M&E officer** (main user): builds the framework, enters or imports data, prepares reports.
- **Org admin / programme manager**: approves frameworks, watches progress, receives alerts.
- **Donor viewer**: read-only access to approved indicators and reports.
- **Consultancy (e.g., Momentum Labs)**: runs baselines, midterms and endlines for client organisations through the assessments pipeline.

**What makes it different from data-collection tools.** KoboToolbox and similar tools collect data well; ActivityInfo and others store and chart it. Raqib's edge is upstream and downstream of collection: it designs the framework with donor-standard indicators, checks indicator quality, watches progress actively, and drafts the narrative. It should import from KoboToolbox rather than compete with it.

**Product principles**

1. **Standard first.** Suggest recognised indicators (EU GERF, ECHO KRIs, Sphere, WFP, cluster standards) before custom ones, and show the source.
2. **Explain everything.** Every AI suggestion carries a short reason and its source; every alert says what to do next.
3. **The human approves.** AI drafts, people decide. Nothing AI-written reaches a donor view without approval.
4. **Bilingual by design.** Arabic and English with proper right-to-left layout, not a translation afterthought.
5. **Calm, clear interface.** Few screens, plain language, M&E terms explained in place.
6. **Private by default.** Beneficiary data never leaves the organisation's space; AI receives aggregates only.

---

## 2. Current state (audit of 11 October 2026)

What exists — the foundation is good:

- **Backend** (`raqib-backend`): Express 4 + TypeScript, Prisma on PostgreSQL with pgvector, BullMQ jobs, JWT auth with roles (platform_admin, org_admin, me_officer, donor_viewer), audit middleware. 69 API endpoints covering organisations, users, projects, documents, frameworks, indicators, data points, assessments, qualitative entries, reports, beneficiaries, templates, exports, dashboard and webhooks (KoboToolbox, Manasati). Seven AI services: document parser, framework generator, indicator alternatives, qualitative coder, report narrative, risk analyser, assessment generator.
- **Frontend** (`raqib-frontend`): Vite + React 18 + TypeScript + shadcn/ui + TanStack Query, built in Lovable. Pages: Login, Dashboard, Projects, Project detail, AI Wizard, Assessments, Beneficiaries, Reports, Settings. Uses the real API (`src/services/api.ts`); mock data is used only for labels. Vitest and Playwright are configured.
- **No secrets are committed** in either repository (checked).

What must be fixed (verified by running the tools):

| # | Finding | Impact |
|---|---|---|
| F1 | Backend does not compile: `bullmq` and `ioredis` are imported but missing from `package.json` | Server and worker cannot start from a clean install |
| F2 | `npm run build` is `prisma generate && tsc || true`, which hides all type errors | Broken code can ship |
| F3 | `@types/express` v5 is installed with Express 4, causing `string | string[]` errors on `req.params` in 8 routes | Type errors; risk of real bugs |
| F4 | `src/index.ts` serves `/uploads` as public static files | Uploaded project documents are reachable by anyone with the URL |
| F5 | `/api/webhooks/kobotoolbox` and `/api/webhooks/manasati` accept unauthenticated requests and trust `project_id` from the body | Anyone can inject data into any project |
| F6 | No security headers or rate limiting; JWT secrets are not validated at startup | Basic hardening missing |
| F7 | AI services use the old model id `claude-sonnet-4-20250514` and parse free-text JSON; SDK is `@anthropic-ai/sdk` 0.39 | Fragile outputs; outdated models |
| F8 | `METemplate` library is seeded with 16 generic indicators; embedding column is `vector(1536)` but no embedding provider is wired | KPI suggestions have little to draw on |
| F9 | Indicators lack reference-sheet fields (definition, calculation, disaggregation, direction, means of verification, baseline date/method, provenance); results chain is stored as unstructured AI JSON | Frameworks are not donor-grade |
| F10 | `DonorType` enum lacks ECHO, WFP, FCDO; `USAID` is now a legacy donor (programmes moved to the US State Department in July 2025) | Donor-specific rules cannot be applied |
| F11 | Frontend type error in `Settings.tsx` (`organizationId` on `User`); ESLint reports 105 errors and 8 warnings; main bundle is 981 kB (275 kB gzipped) | Quality and performance |
| F12 | Seed creates users with the password `admin123` | Acceptable for local dev only |
| F13 | Only one placeholder frontend test; no backend tests; no CI | Regressions go unnoticed |
| F14 | `vercel.json` sends an empty `Content-Security-Policy` header | No CSP protection |
| F15 | README is the Lovable placeholder | Onboarding friction |

---

## 3. Target architecture

```
Browser (React, Vercel)
   │  HTTPS, JWT
   ▼
API server (Express 5 or 4, Node 22)  ──►  PostgreSQL + pgvector (Supabase)
   │                                        Supabase Storage (private bucket, signed URLs)
   ├──► Redis (BullMQ queues)  ◄── Worker process (AI jobs, monitoring scan, emails)
   ├──► Claude API (claude-sonnet-5-5, claude-haiku-5-5; structured outputs)
   ├──► Voyage AI embeddings (voyage-4, 1024 dims) — optional, with keyword fallback
   └──► Resend (email), KoboToolbox (import)
```

Key decisions:

- **Database:** Supabase Postgres with the `vector` extension. Use separate Supabase projects (or Supabase branches) for development, staging and production. Supabase is already connected to Walid's Claude account, so Claude Code can list projects, create a development branch, run migrations on it and read logs.
- **Files:** move from local `uploads/` to a private Supabase Storage bucket; the API issues short-lived signed URLs after checking organisation membership.
- **AI layer:** one module `src/services/ai/client.ts` owns the Anthropic client, model ids (from env), structured outputs, retries, timeouts, token and cost logging, and prompt versions. All AI services call it.
- **Knowledge:** `knowledge/me-foundations.md` is loaded into AI system prompts; `knowledge/indicator-library.json` seeds the `IndicatorLibraryEntry` table.

---

## 4. Phases

Estimated effort assumes Claude Code doing the implementation with Walid reviewing. Phases 0–3 are the minimum before showing anyone a live demo; Phases 4–6 make it compelling; Phases 7–8 make it pilot-ready.

### Phase 0 — Safety and foundations (≈ 1–2 days)

Tasks:

1. Add an environment schema with zod in `src/config/env.ts`; the server refuses to start if `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET` or `ANTHROPIC_API_KEY` are missing or too short (JWT secrets ≥ 32 characters). Add `AI_MODEL_MAIN=claude-sonnet-5-5`, `AI_MODEL_FAST=claude-haiku-5-5`, `VOYAGE_API_KEY` (optional), `WEBHOOK_SECRET`, `SUPABASE_STORAGE_BUCKET`, `CORS_ORIGINS` to `.env.example`.
2. Remove the public `/uploads` static route (F4). Implement storage through Supabase Storage with a private bucket; `GET /api/documents/:id/download` checks organisation membership and returns a signed URL valid for 5 minutes. Migrate any existing files.
3. Secure webhooks (F5): each organisation gets a webhook token (hashed in the database). Requests must include it (`X-Raqib-Webhook-Token`) and may only write to projects of that organisation. Add an HMAC signature option for KoboToolbox REST services. Log rejected attempts.
4. Add `helmet`, `express-rate-limit` (stricter on `/api/auth/*` and AI endpoints), restrict CORS to `CORS_ORIGINS`, and cap upload size and MIME types in multer.
5. Add an organisation-isolation helper (`assertProjectAccess(req, projectId)`) and use it in every route that takes a project, indicator, document, report or beneficiary id. Some routes already check; make it uniform.
6. Make seed passwords come from an env variable in non-development environments; the seed refuses to run in production.
7. Run `npm audit` in both repos; fix high and critical issues. The `xlsx` 0.18.5 package on npm is no longer updated by its maintainers — move to the official SheetJS distribution or to `exceljs`.
8. Set a real Content-Security-Policy in `vercel.json` (F14).

Acceptance criteria:

- Starting the server without required env variables fails with a clear message.
- A document URL cannot be fetched without a valid session from the owning organisation (test).
- A webhook call without a valid token returns 401; a valid token cannot write to another organisation's project (test).
- A user from organisation A gets 404 for every resource of organisation B (automated test over all routes with ids).
- `npm audit --audit-level=high` reports nothing in either repo.

### Phase 1 — Make it build cleanly (≈ 1 day)

Tasks:

1. Add `bullmq` and `ioredis` to dependencies (F1).
2. Fix Express typing (F3): either pin `@types/express@^4.17` to match Express 4, or upgrade to Express 5 and its types together. Prefer pinning now and upgrading later in a separate PR.
3. Change the build script to `prisma generate && tsc` (F2) and fix all type errors.
4. Move Prisma configuration from `package.json#prisma` to `prisma.config.ts` (Prisma warns this is deprecated).
5. Frontend: fix the `Settings.tsx` type error; add `npm run typecheck` (`tsc -p tsconfig.app.json --noEmit`); triage ESLint — fix real errors, and configure rules for generated shadcn files rather than disabling linting globally.
6. Add route-level code splitting (`React.lazy`) for heavy pages (map, reports, AI wizard) so the main bundle drops well below 500 kB minified.
7. Replace the Lovable README in both repos with setup instructions (env, database, Redis, running server, worker and frontend, running tests).
8. Add GitHub Actions CI in both repos: install, lint, typecheck, unit tests, build — on every pull request.

Acceptance criteria:

- `npm ci && npm run build` succeeds with zero type errors in both repos; CI is green.
- `npm run lint` passes (warnings allowed only with a written reason).
- Main frontend chunk is under 500 kB minified.

### Phase 2 — Data model for donor-grade M&E (≈ 2–3 days)

Read `knowledge/me-foundations.md` §1–4 and `knowledge/kpi-assistant-spec.md` §A5.

Tasks:

1. Add `ResultNode` (goal/outcome/output tree) and link indicators to results (`Indicator.resultId`). Write a migration that converts existing frameworks: create result nodes from the stored project structure where available; otherwise attach indicators to a placeholder node per level.
2. Extend `Indicator` with reference-sheet fields: `definition`, `calculation` (JSON: numerator, denominator, formula), `direction`, `disaggregation` (JSON array), `meansOfVerification`, `baselineDate`, `baselineMethod`, `targetJustification`, `assumptions`, `libraryId`, `standardReferenceCode`, `provenance`, `aiModel`, `promptVersion`, and intermediate targets (JSON array of `{date, value}`).
3. Disaggregated data: add `DataPoint.breakdown` (JSON, e.g. `{ "sex": { "female": 120, "male": 98 }, "disability": { "yes": 12, "no": 206 } }`) and validate that breakdown totals match `value` where the unit is a count.
4. Extend enums: `DonorType` add `echo`, `wfp`, `unfpa`, `fcdo`, `un_women`; keep `usaid` labelled "USAID (legacy)" in the UI. `Sector` add `mhpss`, `cash`, `shelter`, `climate_energy`. Allow multiple sectors per project (`Project.sectors Sector[]`) while keeping `sector` as the primary one.
5. Replace `METemplate` with `IndicatorLibraryEntry` matching `knowledge/indicator-library.json` (fields: id, sector, tags, level, name, nameAr, definition, unit, calculation, direction, disaggregation, methods, frequency, meansOfVerification, standardReference, isStandard, notes, version, embedding `vector(1024)`). Write an idempotent seed script `npm run seed:library` that upserts by `id`.
6. Add a project flag `humanitarian Boolean` (drives accountability rules and ECHO behaviour).
7. Update `prompts.ts` and the framework generator to read and write the new fields.

Acceptance criteria:

- Migrations run on a fresh database and on a copy of the current seed without data loss (test on a Supabase development branch).
- `npm run seed:library` loads 63 entries; running it twice changes nothing.
- The indicator form in the frontend shows and saves all reference-sheet fields, in English and Arabic.

### Phase 3 — AI foundation (≈ 2 days)

Tasks:

1. Upgrade `@anthropic-ai/sdk` to the current release.
2. Create `src/services/ai/client.ts`:
   - reads `AI_MODEL_MAIN` / `AI_MODEL_FAST`;
   - `generateStructured<T>({ model, system, messages, schema, maxTokens, promptVersion })` using structured outputs (`output_config: { format: { type: 'json_schema', schema } }`), parsing the text block, validating again with zod, and handling `stop_reason` values `max_tokens` (one retry with a higher limit) and `refusal` (typed error);
   - retries with exponential backoff on 429/5xx; 60-second timeout;
   - logs model, prompt version, input/output tokens, latency and estimated cost to an `AiCall` table (no personal data in logs).
3. Load `knowledge/me-foundations.md` at startup and build the shared system prompt (role + foundations §1–12). Enable prompt caching on that system block.
4. Migrate all seven AI services to `client.ts` and structured outputs; delete `cleanJsonResponse`.
5. Add a redaction step in the document parser: remove phone numbers and Palestinian ID numbers (9-digit patterns) from `parsedText` before AI use; keep the original file private.
6. Embeddings: implement `EmbeddingProvider` with a Voyage implementation (`voyage-4`, 1024 dims) and a no-op provider. `npm run seed:library` embeds entries when a key is present.

Acceptance criteria:

- No AI service contains a hard-coded model id or manual JSON cleaning.
- Unit tests mock the Anthropic client and cover success, malformed output, `max_tokens` and `refusal` paths.
- A framework generation on the seed project completes and stores indicators with all new fields filled or explicitly marked "to be confirmed".

### Phase 4 — KPI Assistant (≈ 4–5 days)

Implement exactly as specified in `knowledge/kpi-assistant-spec.md` Part A: context builder, candidate retrieval (with keyword fallback), structured model call, deterministic validation and scoring, `KpiSuggestion` storage, API routes, UI cards with Accept / Edit & accept / Reject / Alternatives, feedback capture, and the evaluation harness `npm run eval:kpi` using `knowledge/kpi-eval-cases.json`.

Acceptance criteria:

- All validation rules in spec §A4 Step 3 have unit tests.
- `npm run eval:kpi` meets the targets in spec §A8 (100% schema validity, ≥ 90% assertions, 0 hallucinated document targets, average quality ≥ 80).
- On a result card, a user can get suggestions, accept one, and see it in the framework with provenance "AI suggested" and its library source, in under 30 seconds end to end.
- Rejections with reasons are stored and influence the next suggestions for that organisation (rejected library ids are excluded).

### Phase 5 — Active Monitoring (≈ 3 days)

Implement `knowledge/kpi-assistant-spec.md` Part B: `Insight` model, rules R1–R8 as pure functions with tests, the daily `monitoring-scan` repeatable job, auto-resolution, AI explanation for new critical off-track insights (fast model, aggregates only), dashboard "Attention needed" panel, notification integration, and the Sunday weekly digest email.

Acceptance criteria:

- Rule tests cover increase and decrease indicators, missing data, and boundary values.
- Running the scan twice creates no duplicates; fixing the cause resolves the insight on the next scan.
- On the demo dataset (Phase 8), the dashboard shows at least one insight from each of R1, R2, R3 and R5.

### Phase 6 — Experience overhaul: appealing and easy (≈ 5–7 days)

Read `docs/UX_STANDARDS.md` (frontend repo) and apply it. Main work:

1. **First-run onboarding**: a three-step guided start (organisation profile → create first project → upload proposal or start from a sector template). Show progress and what comes next.
2. **Project setup flow** replacing the current AI Wizard: Upload → Results chain review (editable tree) → Suggest KPIs per result → Baselines and targets (with "pending baseline" allowed) → Data plan (who, how, when) → Approve. Each step can be saved and resumed.
3. **Framework page**: results tree on the left, indicator details on the right; drag to reorder; inline quality badges; "Suggest KPIs" on every result.
4. **Data entry**: a fast, mobile-friendly form per indicator with disaggregation inputs that add up automatically; bulk import from Excel/CSV with a column-mapping step and a preview of errors before saving; KoboToolbox import using the secured webhook.
5. **Dashboard**: portfolio view (projects as cards with status), project view (KPI scorecard, trend lines with targets, "Attention needed" panel, recent activity). Status always shown with text and icon, not colour alone.
6. **Reports**: choose period and donor format, preview the AI narrative, edit it, export to Word and PDF.
7. **Arabic and RTL**: full translation files (`src/i18n/en.json`, `src/i18n/ar.json`), `dir="rtl"` on the root when Arabic is selected, logical CSS properties, an Arabic-capable font, Arabic number formatting option.
8. **Help in place**: a glossary popover on M&E terms (indicator, baseline, means of verification, disaggregation…) using text from `me-foundations.md` §1.
9. **Empty states and loading**: every list has a helpful empty state with the next action; skeletons instead of spinners; optimistic updates with undo for deletions.

Acceptance criteria:

- A first-time user can go from sign-up to an approved framework with KPIs for a sample project in under 20 minutes without help (test with two people who did not build the product).
- Lighthouse on the dashboard: Accessibility ≥ 95, Best Practices ≥ 95, Performance ≥ 85 (desktop).
- Automated accessibility checks (axe) on the main pages report no serious or critical violations.
- Every page works in Arabic with correct RTL layout (Playwright screenshot tests in both languages).

### Phase 7 — Testing and quality gates (≈ 3 days, then continuous)

See §7 for the full strategy. Deliver: backend unit and integration tests (Vitest + Supertest against a test database), frontend component tests, Playwright end-to-end journeys, AI evaluation in CI (nightly, small budget), accessibility checks, and a pre-release checklist.

Acceptance criteria:

- Backend line coverage ≥ 70% on `services/` and `routes/`; 100% of validation and monitoring rules covered.
- The six critical journeys in §7.3 pass in CI on every pull request (against a seeded test database with the AI mocked) and nightly against staging with the real AI.

### Phase 8 — Deploy, demo and pilot readiness (≈ 2–3 days)

Tasks:

1. Environments: development, staging and production Supabase projects (or branches); backend API and worker on a Node host with Redis (for example Render, Railway or Fly.io with a managed Redis such as Upstash); frontend on Vercel with `VITE_API_URL` per environment.
2. Error monitoring (Sentry or similar) on frontend, API and worker; uptime check on `/api/health`.
3. Daily database backups and a tested restore.
4. **Demo organisation**: a seed script `npm run seed:demo` that creates "Demo NGO" with two realistic projects (use CASE-02 Hebron youth employment and CASE-05 Gaza food assistance from the eval file), three quarters of data showing some indicators on track and some off track, qualitative entries, and a draft report. Demo login is read-only for viewers and resettable nightly.
5. Product analytics (privacy-respecting, no personal data): time to first framework, suggestions accepted vs rejected, data points entered per week, weekly active users per organisation.
6. Simple legal pages: privacy notice, data processing terms, and AI use statement (what is sent to AI providers and what is not).

Acceptance criteria:

- Staging and production deploy from the main branch through CI with migrations applied automatically and safely.
- The demo can be shown from a phone and a laptop without errors.
- Restoring yesterday's backup into a fresh database works (documented).

---

## 5. UX standards (summary — full version in the frontend repo `docs/UX_STANDARDS.md`)

- **Clarity over density.** One primary action per screen; secondary actions in menus.
- **Plain language.** "Add data" not "Create data point record". Explain M&E terms in tooltips.
- **Bilingual.** Every string in translation files; Arabic reviewed by a native speaker; RTL tested.
- **Status design.** On track / At risk / Off track / No data / Not started — each with text, icon and colour; colour-blind safe palette.
- **Feedback.** Every action confirms (toast) or explains failure in human words with a next step.
- **Forms.** Autosave drafts, inline validation, sensible defaults from the indicator library.
- **Accessibility.** WCAG 2.2 AA: keyboard navigation, visible focus, labels on all inputs, contrast ≥ 4.5:1 for text.
- **Mobile.** Data entry and dashboard fully usable at 375 px width.
- **Performance.** Route-level code splitting; skeleton loading; TanStack Query caching with sensible stale times.
- **Brand.** Decide whether Raqib keeps its own identity or is presented as a Momentum Labs product; if the latter, apply the Momentum Labs palette (red #EE2530, salmon #F8D6D0, navy) through design tokens, not hard-coded colours.

---

## 6. AI behaviour rules (apply to every AI feature)

1. Follow `knowledge/me-foundations.md`; when a donor's rules are known, they override general rules.
2. Never invent baselines, targets or statistics. Cite documents or standards; otherwise propose a method.
3. Prefer library and donor-standard indicators; mark custom ones and say why.
4. Return structured output only; the server validates everything again.
5. Never receive beneficiary-level personal data; aggregates only.
6. Show the user the source and the reason for every suggestion; label AI-written content until approved.
7. Log model, prompt version, tokens and cost for every call; keep prompts in versioned files.

---

## 7. Testing strategy

### 7.1 Backend

- **Unit tests (Vitest):** validation rules, scoring, monitoring rules, progress calculations, disaggregation totals, redaction, env schema, AI client error handling (mocked SDK).
- **Integration tests (Supertest):** every route for happy path, validation errors, role permissions, and organisation isolation. Use a disposable database (Docker Postgres with pgvector locally; a Supabase development branch in CI).
- **Job tests:** framework generation, KPI suggestion and monitoring scan run end-to-end with the AI mocked.

### 7.2 AI evaluation

- `npm run eval:kpi` (spec §A8) on every change to prompts, library or validation; nightly in CI with a spending cap.
- A small set of "golden" framework generations reviewed by an M&E specialist each release; store reviewer notes.

### 7.3 End-to-end (Playwright, both languages)

1. Sign in → create project → upload proposal → generate framework → approve.
2. Open framework → Suggest KPIs for an outcome → accept one → edit another → reject one with a reason.
3. Enter quarterly data with sex disaggregation → see the KPI scorecard update.
4. Import data from an Excel file with one bad row → see the error preview → fix → import.
5. Monitoring scan (triggered in test mode) → insight appears → resolve it by adding data → insight closes.
6. Generate a quarterly report → edit narrative → export Word and PDF.

Also: org isolation (user A cannot open user B's project URL), donor viewer cannot edit, accessibility checks with axe on each page.

### 7.4 Pre-release checklist

- [ ] CI green in both repos; no high/critical `npm audit` findings
- [ ] Migrations tested on a copy of production data
- [ ] `eval:kpi` meets targets
- [ ] Arabic screens reviewed by a native speaker
- [ ] Backups verified; error monitoring receiving events
- [ ] Release notes written in plain language

---

## 8. Definition of done (every pull request)

- Builds, lints and type-checks cleanly; tests added or updated; CI green.
- No secrets, no personal data in logs or fixtures.
- UI changes checked in English and Arabic, desktop and mobile; screenshots attached to the PR.
- Docs updated (README, this guide's status table if a phase is completed).
- PR description lists what changed, why, how it was tested, and anything left for later.

---

## 9. Prompts to start each phase in Claude Code

Paste the matching prompt at the start of a session (in the repository named).

**Phase 0 (backend, then frontend for CSP):**
> Read CLAUDE.md, docs/BUILD_GUIDE.md and knowledge/me-foundations.md §12. Enter plan mode and plan Phase 0 (Safety and foundations). List every route that takes an id and how you will enforce organisation isolation. Then implement on branch phase-0-safety, with tests for document access, webhook auth and org isolation. Ask me before migrating any stored files.

**Phase 1 (both repos):**
> Implement Phase 1 of docs/BUILD_GUIDE.md on branch phase-1-build. Fix the build so type errors fail it, add the missing queue dependencies, fix Express typings, add CI. Show me the before/after output of the build, lint and test commands.

**Phase 2 (backend first, then frontend forms):**
> Implement Phase 2 using knowledge/kpi-assistant-spec.md §A5 and knowledge/indicator-library.json. Create a Supabase development branch for the migration, run it there first, and show me the migration SQL before applying anything to a shared database.

**Phase 3 (backend):**
> Implement Phase 3. Build src/services/ai/client.ts with structured outputs and move every AI service to it. Load knowledge/me-foundations.md as the shared system prompt. Add unit tests with a mocked SDK.

**Phase 4 (backend then frontend):**
> Implement the KPI Assistant exactly as specified in knowledge/kpi-assistant-spec.md Part A. Start with validate.ts and its tests, then retrieval, then the model call, then routes, then UI. Finish by running npm run eval:kpi and paste the summary table into the PR.

**Phase 5:**
> Implement Active Monitoring from knowledge/kpi-assistant-spec.md Part B. Rules first as pure functions with tests, then the daily job, then the dashboard panel and weekly digest.

**Phase 6 (frontend):**
> Read docs/UX_STANDARDS.md. Plan the Phase 6 experience overhaul screen by screen and show me wireframe descriptions before coding. Then implement in small PRs: onboarding, project setup flow, framework page, data entry and import, dashboard, reports, i18n/RTL.

**Phase 7 and 8:**
> Implement Phase 7 tests and the CI gates, then Phase 8 deployment and the demo seed. Give me a short runbook for deploying and restoring backups.

---

## 10. Decisions Walid needs to make (before Phase 6 and Phase 8)

1. **Brand:** Raqib as its own brand, or "Raqib by Momentum Labs" with the Momentum Labs design system.
2. **Hosting provider** for the API and worker, and who pays during the pilot.
3. **Pilot partners:** two or three organisations (one humanitarian, one development) and the projects they will use.
4. **Pricing hypothesis** to test in the pilot (per organisation per year, per active project, or bundled with Momentum Labs assessments).
5. **Data protection:** where production data is hosted, who can access it, and the data processing agreement offered to pilot organisations.

---

## Status table

| Phase | Status | PR | Notes |
|---|---|---|---|
| 0 Safety | In review | | Frontend `npm audit` still reports high/critical findings in build tooling (Tailwind 3, Vite 5, Vitest 3) that need major upgrades — moved to Phase 1. Schema change not yet applied to Supabase. |
| 1 Build | Not started | | |
| 2 Data model | Not started | | |
| 3 AI foundation | Not started | | |
| 4 KPI Assistant | Not started | | |
| 5 Active Monitoring | Not started | | |
| 6 Experience | Not started | | |
| 7 Testing | Not started | | |
| 8 Deploy & demo | Not started | | |
