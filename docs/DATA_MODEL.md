# Data model (Phase 2 and Phase 3)

What Phase 2 (donor-grade M&E, §1–6) and Phase 3 (AI foundation, §7–8) add to the database, in plain language, and how to roll the reviewed SQL out to a shared or Supabase database (§9–10). The schema itself is `prisma/schema.prisma`; the M&E rules behind it are in `knowledge/me-foundations.md` §1–6, the privacy rules in §12.

All changes are additive. No table or column is dropped or renamed. `METemplate` is **deprecated but kept** (replaced by `IndicatorLibraryEntry`; removing it needs explicit approval).

## 1. Results chain (`ResultNode`)

A framework now stores its results chain as a tree instead of untyped JSON:

```
Goal (impact)
└── O1 (outcome)
    ├── O1.1 (output)
    │   └── A1.1.1 (activity)
    └── O1.2 (output)
```

| Field | Meaning |
|---|---|
| `frameworkId` | the framework the node belongs to (deleting a framework deletes its nodes) |
| `parentId` | the node one level up, or empty |
| `level` | `impact`, `outcome`, `output` or `activity` |
| `code` | short label shown in the logframe, e.g. `Goal`, `O1`, `O1.1`; unique within a framework (the API rejects duplicates ignoring case with 409; the unique index `ResultNode_frameworkId_code_key` also stops races and direct writes, answered with the same 409 "A result with that code already exists in this framework") |
| `text`, `textAr` | the result statement in English and Arabic |
| `sortOrder` | order among siblings |

**Hierarchy rule** (enforced by the API, `src/services/indicators/hierarchy.ts`): a parent is optional; when present it is in the same framework and exactly one level up — an outcome's parent is an impact, an output's parent an outcome, an activity's parent an output. An impact never has a parent.

Each indicator can point to the result it measures (`Indicator.resultId`). A node with children cannot be deleted (409); deleting a node without children unlinks its indicators (`ON DELETE SET NULL`).

**Level fits the result** (`knowledge/me-foundations.md` §2 rule 5): a linked indicator has its result's level. On create, and on a PATCH that sets `level` or `resultId`, the API answers 400 `level must match the result it measures (<level>)` when they differ; linking a result without sending a level takes the result's level. A PATCH that touches neither field does not re-check older data. Changing a result's level (PATCH /api/results/:id) moves its linked indicators to the new level in the same transaction; the response adds `updatedIndicators` (how many moved, 0 when the level did not change).

The project export (GET /api/projects/:id/export) includes the results chain as `frameworks[].resultNodes` (`id`, `code`, `level`, `text`, `textAr`, `parentId`, in display order) and every reference-sheet field below on each indicator, with its `resultCode`.

**Existing frameworks.** The old framework generator never stored the results chain, so the migration gives every framework one placeholder node per level its indicators use and links each indicator to it:

| Level | Code | Text |
|---|---|---|
| impact | `Goal` | Impact indicators (results chain to be completed) — مؤشرات الأثر (سلسلة النتائج قيد الاستكمال) |
| outcome | `O` | Outcome indicators (results chain to be completed) — مؤشرات المحصلات (سلسلة النتائج قيد الاستكمال) |
| output | `OP` | Output indicators (results chain to be completed) — مؤشرات المخرجات (سلسلة النتائج قيد الاستكمال) |
| activity | `A` | Activity indicators (results chain to be completed) — مؤشرات الأنشطة (سلسلة النتائج قيد الاستكمال) |

Placeholders are chained so the hierarchy rule holds (the outcome placeholder's parent is the framework's impact placeholder if there is one, and so on). A framework gets at most one placeholder per level and the four codes differ (also ignoring case), so they never clash with the unique code index. M&E officers replace them with the real results in the framework editor. The Arabic texts are drafts for review by a native-speaking M&E specialist.

## 2. Indicator reference sheet

New optional fields on `Indicator` (`knowledge/me-foundations.md` §3). Existing indicators keep all their values; the new fields start empty and are never filled with invented values.

| Field | Format | Notes |
|---|---|---|
| `resultId` | id or null | result it measures; must be in the same framework |
| `definition` | text | what exactly counts, key terms defined |
| `calculation` | `{ numerator?, denominator?, formula?, rounding? }` | percentages need a numerator and a denominator |
| `direction` | `increase` \| `decrease` \| `maintain` | desired direction; never part of the indicator wording |
| `disaggregation` | `["sex", "age", "disability", ...]` | groups to break the value down by; sex is the minimum for people-level indicators |
| `meansOfVerification` | text | specific source and tool, not "project reports" |
| `baselineDate`, `baselineMethod` | `YYYY-MM-DD`, text | with the existing `baselineValue` |
| `intermediateTargets` | `[{ "date": "YYYY-MM-DD", "value": "..." }]` | with the existing final `targetValue` |
| `targetJustification` | text | why the target is realistic |
| `assumptions` | text | assumptions and data limitations |
| `libraryId` | library id or null | the library entry it came from, e.g. `FS-01`; trimmed and upper-cased by the API (`fs-01` finds `FS-01`, also in GET /api/indicator-library/:id) |
| `standardReferenceCode` | text | framework code, e.g. `GERF 2.38`, `IASC MHPSS O5.4` |
| `provenance`, `aiModel`, `promptVersion` | see below | |

## 3. Provenance

Where an indicator came from:

| Value | Set by |
|---|---|
| `manual` | typed in by a user (default) |
| `library` | added from the indicator library (`libraryId` set) |
| `imported` | imported from a file or another system |
| `ai_generated` | created by the AI framework generator (`aiModel`, `promptVersion` set) |
| `ai_suggested` | accepted from a KPI Assistant suggestion (Phase 4) |

Provenance is accepted on create only: `manual`, `library` or `imported` (the `ai_*` values are set by the server; the API answers 400 for them), and a `libraryId` sent without provenance means `library`. On PATCH a `provenance` field is ignored and the server works it out: a `manual` or `library` indicator follows its library link (`library` while `libraryId` is set, `manual` when it is empty); `ai_generated`, `ai_suggested` and `imported` never change. Approving a framework (PATCH /api/frameworks/:id/approve) approves all its indicators in the same transaction, so their "AI suggested — review before approval" label goes away with it.

The migration marks an existing indicator `ai_generated`, with `aiModel` = the framework's `aiModelUsed`, only when the framework's `aiModelUsed` is a model id (not empty, not `manual`) **and** the indicator was created at most one hour after the framework (`createdAt <= generatedAt + 1 hour`; the old generator created all its indicators right after the framework). Everything else is `manual`, including indicators that people added by hand to an AI-generated framework later.

## 4. Disaggregated data (`DataPoint.breakdown`)

A data point can carry its value broken down by group, one object per dimension:

```json
{
  "sex": { "female": 120, "male": 98 },
  "disability": { "yes": 12, "no": 206 }
}
```

Values are numbers. The rules follow the indicator's unit (`src/services/dataPoints/breakdown.ts`); an explicit unit always wins:

- **Count** (number, people, households, …): the data point's `value` must be a number, and each dimension's categories must add up to it (here 218).
- **Percentage**: each category is a rate from 0 to 100; categories do not add up.
- **No unit**: percentage rules when the indicator text reads as a percentage (starts with `%`, or says percent, percentage, proportion, share, rate, نسبة or معدل); otherwise no sum check. A blank unit is no longer treated as a count.

Every problem in a data point is reported together in one 400 (bulk import prefixes each message with its row number). `breakdown` is optional and empty for all existing data points.

Numeric values are stored in canonical form, `String(number)`: `"١٬٢٠٠"`, `"1,200"` and `"1200.0"` become `"1200"`, in `DataPoint.value` and in `Indicator.currentValue`, and also for data arriving through the KoboToolbox and Manasati webhooks. Other values (`"Yes"`) are stored as sent. Single entry sets `currentValue` to the value just recorded; bulk import sets each imported indicator's `currentValue` to its most recent data point by collection date. Recording data (single and bulk) is open to org admins and M&E officers; donor viewers get 403.

## 5. Projects and enums

- `Project.sectors` lists all sectors of a project; the primary `sector` is always included. The migration sets `sectors = [sector]` for existing projects.
- `Project.humanitarian` (default `false`) drives accountability rules and ECHO behaviour.
- `Sector` gains `mhpss`, `cash`, `shelter`, `climate_energy`.
- `DonorType` gains `echo`, `wfp`, `unfpa`, `fcdo`, `un_women`. `usaid` is kept as a legacy value (shown as "USAID (legacy)"; USAID stopped administering awards on 1 July 2025).
- New enums `IndicatorDirection` and `IndicatorProvenance`.

## 6. Indicator library (`IndicatorLibraryEntry`)

The seed library of standard and common-practice indicators. The source of truth is `knowledge/indicator-library.json` (63 entries, version in `meta.version`); the table mirrors it: `id` (e.g. `FS-01`), `sector`, `tags`, `level`, `name`, `nameAr`, `definition`, `unit`, `calculation`, `direction`, `disaggregation`, `methods`, `frequency`, `meansOfVerification`, `standardReference` (`{ framework, code, url }`), `standardFramework` (copy of `standardReference.framework`, for filtering), `isStandard`, `notes`, `version`, and `embedding vector(1024)`.

- Load or refresh it with `npm run seed:library`. It upserts by `id`, updates only entries whose content changed, never deletes, and running it twice changes nothing. It is safe in any environment.
- `embedding` is filled by `npm run seed:library` when `VOYAGE_API_KEY` is set (Voyage, input type `document`; text = name, Arabic name, definition and tags). An update that changes any of those fields clears the vector in the same transaction, so a stale vector is never searched; the next run with a key embeds it again. `npm run seed:library -- --reembed` re-embeds every entry (needed after changing `VOYAGE_MODEL`). Prisma never returns this column; read and write it with raw SQL and `::vector`. See `docs/AI.md` §8.
- The API reads it at `GET /api/indicator-library` (filters `sector`, `level`, `framework`, `q`, `isStandard`) and `GET /api/indicator-library/:id`. The library is global (not owned by an organisation); both routes need a signed-in user.

## 7. AI call log (`AiCall`, Phase 3)

One row per AI model call, written by `src/services/ai/client.ts` (the only module that calls the Anthropic API) when the call ends, whether it succeeded or failed. It answers "what did AI cost, for whom, with which model and prompt version, and how often does it fail" (`docs/BUILD_GUIDE.md` §6 rule 7). Writing the row never fails the call: if the insert fails, the client logs a warning with the error class name and carries on.

| Field | Meaning |
|---|---|
| `feature` | stable feature id: `framework.structure`, `framework.indicators`, `document.analysis`, `indicator.alternatives`, `qualitative.coding`, `report.narrative`, `risk.analysis`, `assessment.report` |
| `model` | model requested (`AI_MODEL_MAIN` or `AI_MODEL_FAST`) |
| `servedModel` | model that produced the answer; differs from `model` after a server-side fallback; empty when no answer came back |
| `promptVersion`, `systemPromptVersion` | version of the feature prompt (e.g. `framework-v4`) and of the shared system prompt |
| `status` | `success`; `refusal` (the model declined); `max_tokens` (answer still cut off after the one retry with a higher limit); `invalid_output` (answer did not match the schema); `error` (request failed after the retries: rate limit, overload, server or network error, timeout) |
| `stopReason` | the API's stop reason of the last response, e.g. `end_turn` |
| `errorType` | error class name only (e.g. `AiRefusalError`), never the message |
| `attempts` | API requests made, retries included (default 1) |
| `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` | summed over all attempts (default 0) |
| `latencyMs` | wall-clock time of the whole call, retries included |
| `estimatedCostUsd` | `numeric(12,6)`, from the price table in `src/services/ai/models.ts`; empty for a model the table does not know. An estimate, not the invoice |
| `organizationId`, `projectId` | who the call was for (ids only, for cost attribution); empty for calls without an organisation, e.g. scripts |
| `createdAt` | when the call ended |

**Never stored** (here or in the console line the client prints with the same numbers): prompts, document text, model answers, error messages, user ids, or any personal data. Prompts live in versioned files in `src/services/ai/prompts/`; the version on the row says which one was used.

- Deleting an organisation or project keeps its AI calls with the link emptied (`ON DELETE SET NULL`), so cost history survives; renaming an id follows (`ON UPDATE CASCADE`).
- Indexes: `AiCall_createdAt_idx` (`createdAt`), `AiCall_organizationId_createdAt_idx` (`organizationId`, `createdAt`), `AiCall_feature_createdAt_idx` (`feature`, `createdAt`).
- Row level security is enabled with no policies (like `WebhookToken`, `ResultNode` and `IndicatorLibraryEntry`), so the table is never readable through Supabase's Data API with the anon key. No API route reads it yet; a future one must filter by `req.user.organizationId` (CLAUDE.md rule 1).
- Rows hold no personal data and there is no automatic clean-up yet.

Examples (run against a read replica or in a quiet period):

```sql
-- Estimated cost and calls per organisation and month
SELECT date_trunc('month', "createdAt") AS month, "organizationId", count(*) AS calls, sum("estimatedCostUsd") AS usd
FROM "AiCall" GROUP BY 1, 2 ORDER BY 1 DESC, usd DESC NULLS LAST;

-- Failures by feature over the last 7 days
SELECT feature, status, count(*) FROM "AiCall"
WHERE "createdAt" > now() - interval '7 days' AND status <> 'success' GROUP BY 1, 2 ORDER BY 3 DESC;
```

## 8. Document text and AI analysis (`Document.parsedText`, `Document.aiAnalysis`, Phase 3)

**`parsedText`** is the text extracted from the uploaded file (PDF, Word, Excel; OCR for scanned PDFs) **with phone numbers, ID numbers (9-digit runs) and email addresses replaced** by `[phone removed]`, `[ID number removed]` and `[email removed]` (`src/services/ai/redact.ts`, CLAUDE.md rule 5). Only this redacted text is stored for AI use or sent to a model, and the application redacts it again just before every AI use, because rows parsed before Phase 3 were stored without redaction (the migration moves text, it does not rewrite it: a SQL pattern would not match the tested redaction rules). Uploading the document again stores redacted text. The original file stays in the private storage bucket. Names and street addresses cannot be recognised reliably by patterns; the prompts tell the model never to output them.

**`aiAnalysis`** (`jsonb`, nullable) is the model's analysis of the document, kept apart from the document's own text so that model output can never "prove" a baseline or target (`knowledge/me-foundations.md` §6). The parser stores it after the text; a new parse empties it first.

```json
{
  "documentType": "proposal",
  "summary": "…",
  "keyFindings": ["…"],
  "indicatorsMentioned": ["…"],
  "targetsMentioned": [{ "indicator": "…", "target": "…", "timeline": "…" }],
  "recommendations": ["…"],
  "model": "claude-haiku-5-5",
  "promptVersion": "document-analysis-v2",
  "analysedAt": "2026-10-12T09:30:00.000Z"
}
```

`documentType` is one of `proposal`, `logframe`, `budget`, `report`, `guidelines`, `other`. `model` is the served model.

**Legacy rows.** Before Phase 3 the parser appended the analysis to `parsedText` as `<text>\n\n---AI_ANALYSIS---\n<model answer>`. The Phase 3 SQL moves it, splitting at the first marker as the application's readers do:

| Text after the marker | `aiAnalysis` becomes | `parsedText` becomes |
|---|---|---|
| a JSON object (no key repeated at any depth) | that object, with its original keys (`document_type`, `key_findings`, `indicators_mentioned`, `targets_mentioned`, …; no `model`, `promptVersion`, `analysedAt`) | the text before the marker, trailing whitespace trimmed |
| anything else: invalid JSON (e.g. an answer cut off), an array, a JSON value `jsonb` cannot store (`\u0000`), an object with a repeated key | `{ "legacyText": "<the text after the marker, as stored>" }` | the same |
| only whitespace | stays empty | the same |

Nothing is lost: the self-check in the SQL file (and `scripts/verify-migrations.sh`) proves that the old `parsedText` is the new `parsedText` + whitespace + marker + what `aiAnalysis` holds, for every moved row, and that documents without the marker are untouched. Readers in the API and the frontend accept both spellings of the keys, show nothing for `{legacyText}`, and still read the marker form in `parsedText`, which documents parsed by the old API after the SQL ran will have (§9 step 8).

## 9. Rolling out to a shared or Supabase database

Locally, `npx prisma db push` is enough. Shared databases get the reviewed SQL files, **in this order**; each one runs once:

| Order | File | Upgrades | Adds |
|---|---|---|---|
| 1 | `prisma/sql/2026-10-11_phase0_webhook_tokens.sql` | the schema at `df6c1f6` (what the shared Supabase database has today: the Phase 0 SQL is not applied yet; step 5 checks) | `WebhookToken`, RLS on it |
| 2 | `prisma/sql/2026-10-11_phase2_data_model.sql` | the schema at `022e09a` (Phase 0/1) | §1–6; RLS on `ResultNode` and `IndicatorLibraryEntry` |
| 3 | `prisma/sql/2026-10-12_phase3_ai_foundation.sql` | the schema at `642c474` (Phase 2) | §7–8; RLS on `AiCall` |

The Phase 2 file adds its enum values first (outside its transaction, safe to repeat); otherwise the Phase 2 and Phase 3 files each run in one transaction that starts with a guard and ends with a self-check, so any failure rolls everything back. The Phase 2 file refuses to run when `ResultNode` exists. The Phase 3 file refuses to run (and changes nothing) when `AiCall`, the `AiCallStatus` type or `Document.aiAnalysis` already exists, or when `WebhookToken` (Phase 0) or `ResultNode` (Phase 2) is missing. Its transaction creates `AiCallStatus` and `AiCall` with its indexes and foreign keys, adds `Document.aiAnalysis`, moves the legacy analyses (§8), enables RLS on `AiCall` and checks the result: no marker left in any `parsedText`, every moved row reproduces its old text, no other document got an analysis, the table, column and RLS are in place. Its helper functions and work table live in `pg_temp` and disappear with the session.

Steps (CLAUDE.md rule 8: test on a development branch first and show the SQL before touching a shared database). `DIRECT_URL` is the shared database's direct connection (port 5432, not the pooler); `BRANCH_URL` / `BRANCH_DIRECT_URL` are the branch's. Run `psql` without `--single-transaction` (the files manage their own transactions).

1. **Prove it locally.** `npm run verify:migration` (`scripts/verify-migrations.sh`) must end with `PASS` (§10).
2. **Rehearse on a Supabase development branch with made-up data.** The owner decided that the rehearsal uses the dev seed, **never a copy of beneficiary data**. Create the branch (Dashboard → Branches → Create branch, or `supabase branches create phase3-ai-foundation`; resume the project first if it is paused). A new branch is empty; give it today's schema, Phase 0 and the dev seed from `022e09a`:
   ```bash
   git worktree add ../raqib-022e09a 022e09a && cd ../raqib-022e09a && npm ci && npx prisma generate
   git show df6c1f6:prisma/schema.prisma > /tmp/schema-today.prisma
   export DATABASE_URL="$BRANCH_DIRECT_URL" DIRECT_URL="$BRANCH_DIRECT_URL"
   npx prisma db push --schema /tmp/schema-today.prisma --skip-generate
   psql "$BRANCH_DIRECT_URL" -v ON_ERROR_STOP=1 -f <raqib-backend>/prisma/sql/2026-10-11_phase0_webhook_tokens.sql
   NODE_ENV=development SEED_PASSWORD='<throwaway password, 8+ characters>' npm run seed   # made-up demo data
   ```
   The branch is reachable over the internet, hence a throwaway `SEED_PASSWORD` instead of the local demo password. The dev seed has no documents; add two made-up legacy documents so the Phase 3 data move has something to move:
   ```sql
   INSERT INTO "Document" (id, "projectId", "uploadedBy", "fileName", "fileUrl", "fileType", "parsedText", "parsingStatus")
   SELECT x.id, p.id, u.id, x.id || '.pdf', 'documents/rehearsal/' || x.id || '.pdf', 'proposal', x.pt, 'completed'
   FROM (SELECT id FROM "Project" ORDER BY "createdAt" LIMIT 1) p, (SELECT id FROM "User" ORDER BY "createdAt" LIMIT 1) u,
        (VALUES ('rehearsal-legacy-json', E'Made-up proposal.\n\n---AI_ANALYSIS---\n{"summary":"Made-up summary.","indicators_mentioned":["% of households with acceptable FCS"]}'),
                ('rehearsal-legacy-bad',  E'Made-up report.\n\n---AI_ANALYSIS---\n{"summary": "cut off')) AS x(id, pt);
   ```
3. **Apply Phase 2 and Phase 3 on the branch** (from the `raqib-backend` checkout):
   `psql "$BRANCH_DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/2026-10-11_phase2_data_model.sql`
   `psql "$BRANCH_DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/2026-10-12_phase3_ai_foundation.sql`
   Each ends with `COMMIT`. If the Phase 2 file stops with `type "vector" does not exist`, pgvector lives in the `extensions` schema: add `-c 'SET search_path TO public, extensions'` before `-f`.
4. **Check the branch:**
   - no drift: `DATABASE_URL="$BRANCH_DIRECT_URL" npx prisma migrate diff --from-url "$BRANCH_DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` (exit code 0);
   - `SELECT count(*) FROM "Indicator" WHERE "resultId" IS NULL;` and `SELECT count(*) FROM "Document" WHERE strpos("parsedText", '---AI_ANALYSIS---') > 0;` both return 0;
   - `SELECT id, "parsedText", "aiAnalysis" FROM "Document" WHERE id LIKE 'rehearsal-%';` shows the JSON object and `{"legacyText": "{\"summary\": \"cut off"}`, and `parsedText` without the analysis;
   - `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('WebhookToken', 'ResultNode', 'IndicatorLibraryEntry', 'AiCall');` shows `t` four times;
   - `npm run seed:library` (with `BRANCH_URL`/`BRANCH_DIRECT_URL`) reports 63 entries, and embeds them when `VOYAGE_API_KEY` is set; a second run creates, updates and embeds nothing;
   - point a test API (Phase 3 code, an Anthropic key) and the frontend at the branch, open the seed project's framework and upload a small made-up document: its analysis appears, and `SELECT feature, model, status, "inputTokens", "outputTokens", "estimatedCostUsd" FROM "AiCall" ORDER BY "createdAt" DESC LIMIT 5;` shows the calls.
5. **Back up the shared database** and check where it stands:
   `pg_dump "$DIRECT_URL" --schema=public -Fc --no-owner --no-privileges -f raqib-before-phase3.dump`
   `psql "$DIRECT_URL" -Atc 'SELECT to_regclass($$public."WebhookToken"$$), to_regclass($$public."ResultNode"$$), to_regclass($$public."AiCall"$$)'`
   An empty value means that file has not run yet; start with the first missing one. `SELECT count(*) FROM "Document" WHERE strpos("parsedText", '---AI_ANALYSIS---') > 0;` tells how many documents the Phase 3 file will move. The dump contains personal data: keep it private and delete it when no longer needed.
6. **Get approval** for the SQL and the branch results, then apply the missing files to the shared database in order, in a quiet period, with the same `psql` commands and `DIRECT_URL`. Each transaction takes seconds at current volumes; Phase 3 briefly locks `Document` (new column, moved rows) and `Organization` / `Project` (new foreign keys).
7. **Load the library:** `npm run seed:library` (with `VOYAGE_API_KEY` to embed the entries).
8. **Deploy the API, then the frontend — only after the SQL.** The Phase 3 API reads `Document.aiAnalysis` and writes `AiCall`; on a database without the Phase 3 SQL its document routes fail. The old API keeps working on the new schema (it ignores `AiCall` and `aiAnalysis`); documents it parses before the deploy get the legacy marker in `parsedText`, which every reader still accepts; uploading such a document again moves it to the new form. Phase 2 notes still apply: projects created by the old API in the window get empty `sectors` (`UPDATE "Project" SET "sectors" = ARRAY["sector"] WHERE cardinality("sectors") = 0;`).
9. **Clean up:** delete the development branch and the worktree, record the dates in the status table of `docs/BUILD_GUIDE.md`, and delete the dump according to the data-retention policy.

**Rolling back.** Prefer rolling forward: the changes are additive and the previous API version runs on the new schema, so reverting the code is enough. One visible effect: the pre-Phase 3 frontend reads document analyses only from `parsedText`, so it shows none for moved documents until the Phase 3 code is back (the analyses stay in `aiAnalysis`). Removing tables, columns, enum values or moving analyses back would need a separate reviewed script and explicit approval (no drops without approval); the dump from step 5 is the last resort.

## 10. Verifying the SQL locally

`npm run verify:migration` runs `scripts/verify-migrations.sh` (needs `npm ci`, git history with the revisions below, and a local Postgres with pgvector). It only uses localhost, and refuses URLs with a `host=`/`hostaddr=` parameter or a comma-separated host list unless `VERIFY_ALLOW_NON_LOCAL=1`. It creates throwaway databases named `raqib_mverify_<kind>_<time>_<pid>_<random>_test`, which cannot clash with anyone's test databases (`raqib_test`, `raqib_<key>_test`), and drops only those at the end (`KEEP_DBS=1` keeps them). It ends with `PASS <n> checks passed, 0 failed` or exits 1.

0. **Static:** no file contains a `DROP` statement; the Phase 3 file is one transaction.
1. **Fresh database** (`prisma db push` of the current schema): no drift; the Phase 3 file is refused there ("already applied") without changes; the app's Prisma client creates, reads and deletes `AiCall` rows (defaults, `numeric(12,6)` cost, relations).
2. **Empty database:** the Phase 3 file is refused ("needs the Phase 0 SQL first") and creates nothing; with a leftover `AiCallStatus` type it is refused as "already partly applied".
3. **Copy of the seed** at `022e09a` (old schema, old Prisma client, old seed) plus synthetic fixtures — frameworks and indicators for the Phase 2 edge cases, a beneficiary, and 14 documents, 11 of them in the legacy format (valid JSON, cut-off JSON, an array, repeated keys at the top and deep inside, two markers, only whitespace after the marker, Arabic text, the marker at the very start, `\u0000`, CRLF line ends) and 3 without (plain text with trailing newlines, no text, marker look-alikes that a `LIKE` pattern would catch):
   - the Phase 3 file is refused before Phase 2 ("needs the Phase 2 SQL first") without changes;
   - **Phase 2:** every Phase 2 check (row counts and checksums of every table, results chain links and hierarchy, unique result codes, sectors, provenance, RLS, enum values, the app's Prisma client, a refused second run) and no drift against the Phase 2 schema (`642c474`);
   - **Phase 3:** row counts and checksums of every column of every table unchanged except `Document.parsedText`; `AiCall` columns, types, defaults, enum values, indexes and foreign keys exactly as in `prisma/schema.prisma`, and their behaviour (rename cascades, deletes set the link to NULL) in a rolled-back transaction; RLS on `AiCall` with no policies; `Document.aiAnalysis` is `jsonb`; no `AiCall` rows invented; no `pg_temp` helper left behind; each document fixture moved exactly as §8 says; every document without the marker untouched and nothing lost for every legacy one; no drift against `prisma/schema.prisma`; the app's Prisma client writes and reads `AiCall` rows and reads the moved analyses; a second run refused without changes.
4. **Rollout order** on the schema the shared database has today (`df6c1f6`): the Phase 3 file is refused before Phase 0; the Phase 0, Phase 2 and Phase 3 files apply in order; RLS is on for all four new tables; no drift against `prisma/schema.prisma`.

The revisions can be changed with `BASE_REV`, `PHASE2_REV` and `PRE_PHASE0_REV`, the server with `VERIFY_PG_BASE_URL`.
