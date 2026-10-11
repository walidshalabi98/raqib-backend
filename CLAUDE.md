# CLAUDE.md — raqib-backend

Raqib is an M&E (monitoring and evaluation) platform for NGOs, INGOs and consultancies in Palestine and the region. This repo is the API, the background worker and the AI engine. The frontend lives in `raqib-frontend`.

## Read first

- `docs/BUILD_GUIDE.md` — the phased plan, acceptance criteria and current status table. Work on the phase the user names.
- `knowledge/me-foundations.md` — M&E rules the product and every AI feature must follow.
- `knowledge/kpi-assistant-spec.md` — spec for the KPI Assistant and Active Monitoring.
- `knowledge/indicator-library.json` — seed indicator library (source of truth for `IndicatorLibraryEntry`).
- `knowledge/kpi-eval-cases.json` — AI evaluation cases.

## Stack

Node 22 · TypeScript · Express · Prisma (PostgreSQL + pgvector, hosted on Supabase) · BullMQ + Redis · Anthropic SDK · Resend · multer.

## Commands

```bash
npm ci
npm run dev             # API with watch
npm run worker          # BullMQ worker
npm run build           # must fail on type errors (never add "|| true")
npm run lint
npm test                # Vitest unit + integration
npm run eval:kpi        # KPI Assistant evaluation (uses the real API; costs money)
npx prisma migrate dev  # local only; never against shared databases without asking
npm run seed            # dev seed (refuses to run in production)
npm run seed:library    # idempotent library upsert
```

## Rules

1. **Organisation isolation everywhere.** Every query for a project-owned resource must be scoped to `req.user.organizationId` (use `assertProjectAccess`). Add an isolation test for every new route.
2. **No public files.** Documents live in a private Supabase Storage bucket; serve them via short-lived signed URLs after an access check.
3. **No secrets in code, tests, fixtures or logs.** Configuration comes from the zod-validated env in `src/config/env.ts`.
4. **AI calls go through `src/services/ai/client.ts` only.** Model ids come from `AI_MODEL_MAIN` (default `claude-sonnet-5-5`) and `AI_MODEL_FAST` (default `claude-haiku-5-5`). Use structured outputs (`output_config.format` with a JSON schema), then validate again with zod. Version every prompt (`promptVersion`) and keep prompts in `src/services/ai/prompts/`.
5. **No personal data to AI.** Beneficiary names, IDs, phone numbers and addresses are never sent to any model. Send aggregates only. Redact phone and ID numbers from parsed document text.
6. **AI never invents numbers.** Baselines and targets come from uploaded documents (verified by string match) or recognised standards, otherwise only a target-setting method is suggested. See `me-foundations.md` §6.
7. **Deterministic checks around AI.** Validation and scoring of AI output, and all monitoring rules, are pure functions with unit tests.
8. **Migrations are reviewed.** Show the SQL before applying to any shared database. Test on a Supabase development branch first. Never drop columns or tables without explicit approval.
9. **Ask before destructive actions** (data deletion, auth changes, secret rotation, force pushes).
10. **Definition of done:** build, lint and tests pass; tests added; docs updated; PR description says what, why and how tested. Update the status table in `docs/BUILD_GUIDE.md` when a phase completes.

## Domain glossary (short)

Results chain = goal → outcomes → outputs → activities. Indicator = what is measured (never contains the target). Baseline = starting value with date and method. Target = intended value by a date. Means of verification = the specific source and tool. Disaggregation = breakdown by sex (minimum for people-level indicators), age, disability (Washington Group questions), location, displacement status. KPI = an indicator the organisation tracks on its dashboard. Full definitions: `knowledge/me-foundations.md` §1.

## Context

- Users work in English and Arabic; Arabic text is Modern Standard Arabic.
- The regional work week runs Sunday–Thursday; schedule weekly jobs (digests) for Sunday morning, Asia/Hebron time.
- USAID stopped administering awards on 1 July 2025; treat `usaid` as a legacy donor type.
