# Data model (Phase 2 and Phase 3)

What Phase 2 (donor-grade M&E, §1–6) and Phase 3 (AI foundation, §7–8, plus `IndicatorLibraryEntry.embeddingModel` in §6) add to the database, in plain language, and how to roll the reviewed SQL out to a shared or Supabase database (§9–10). The schema itself is `prisma/schema.prisma`; the M&E rules behind it are in `knowledge/me-foundations.md` §1–6, the privacy rules in §12.

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

The seed library of standard and common-practice indicators. The source of truth is `knowledge/indicator-library.json` (63 entries, version in `meta.version`); the table mirrors it: `id` (e.g. `FS-01`), `sector`, `tags`, `level`, `name`, `nameAr`, `definition`, `unit`, `calculation`, `direction`, `disaggregation`, `methods`, `frequency`, `meansOfVerification`, `standardReference` (`{ framework, code, url }`), `standardFramework` (copy of `standardReference.framework`, for filtering), `isStandard`, `notes`, `version`, `embedding vector(1024)` and, from Phase 3, `embeddingModel` (text, nullable).

- Load or refresh it with `npm run seed:library`. It upserts by `id`, updates only entries whose content changed, never deletes, and running it twice changes nothing. It is safe in any environment.
- `embedding` is filled by `npm run seed:library` when `VOYAGE_API_KEY` is set (Voyage, input type `document`; text = name, Arabic name, definition and tags). An update that changes any of those fields clears the vector in the same transaction, so a stale vector is never searched; the next run with a key embeds it again. Prisma never returns this column; read and write it with raw SQL, casting to the column's own type (on Supabase `extensions.vector`, see §9 "pgvector on Supabase"). See `docs/AI.md` §8.
- `embeddingModel` records the embedding model that produced `embedding` (Phase 3). Vectors of different models cannot be compared, so an entry whose `embeddingModel` differs from the configured model counts as not embedded: after a change of `VOYAGE_MODEL`, or a run that failed half-way, the next run with a key embeds those entries again, and vector search (Phase 4) can filter on the current model. The Phase 3 SQL adds the column empty, so any vector stored before it is treated as made by an unknown model and embedded again. `npm run seed:library -- --reembed` re-embeds every entry.
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
- Indexes: `AiCall_createdAt_idx` (`createdAt`), `AiCall_organizationId_createdAt_idx` (`organizationId`, `createdAt`), `AiCall_feature_createdAt_idx` (`feature`, `createdAt`), `AiCall_projectId_createdAt_idx` (`projectId`, `createdAt`: a project's calls and cost, and the `ON DELETE SET NULL` of a project delete without scanning the whole table).
- Row level security is enabled with no policies (like `WebhookToken`, `ResultNode` and `IndicatorLibraryEntry`), so the table is never readable through Supabase's Data API with the anon key. No API route reads it yet; a future one must filter by `req.user.organizationId` (CLAUDE.md rule 1).
- Rows hold no personal data. They are kept for 24 months (`AI_CALL_RETENTION_MONTHS`, 1–120; owner decision of 12 October 2026): the worker's nightly `prune-ai-calls` job (02:30 Asia/Hebron) deletes older rows by `createdAt`, oldest first, in batches of 5 000, using `AiCall_createdAt_idx`; `npm run ai-calls:prune` does the same by hand (dry run unless `-- --apply`). No schema change was needed. Details: `docs/AI.md` §7.

Examples (run against a read replica or in a quiet period; totals cover at most the retention period):

```sql
-- Estimated cost and calls per organisation and month
SELECT date_trunc('month', "createdAt") AS month, "organizationId", count(*) AS calls, sum("estimatedCostUsd") AS usd
FROM "AiCall" GROUP BY 1, 2 ORDER BY 1 DESC, usd DESC NULLS LAST;

-- Failures by feature over the last 7 days
SELECT feature, status, count(*) FROM "AiCall"
WHERE "createdAt" > now() - interval '7 days' AND status <> 'success' GROUP BY 1, 2 ORDER BY 3 DESC;
```

## 8. Documents and framework versions (Phase 3)

**`parsedText`** is the text extracted from the uploaded file (PDF, Word, Excel; OCR for scanned PDFs) **with phone numbers, ID numbers (9-digit runs) and email addresses replaced** by `[phone removed]`, `[ID number removed]` and `[email removed]` (`src/services/ai/redact.ts`, CLAUDE.md rule 5). Only this redacted text is stored for AI use or sent to a model, and the application redacts it again just before every AI use, because rows parsed before Phase 3 were stored without redaction (the migration moves text, it does not rewrite it: a SQL pattern would not match the tested redaction rules). Uploading the document again stores redacted text, and the one-off backfill `npm run redact:backfill` redacts those rows in place (§9, step "Run the backfill"). The original file stays in the private storage bucket. Names and street addresses cannot be recognised reliably by patterns; the prompts tell the model never to output them.

**`aiAnalysis`** (`jsonb`, nullable) is the model's analysis of the document, kept apart from the document's own text so that model output can never "prove" a baseline or target (`knowledge/me-foundations.md` §6). The parser stores it after the text; a new parse empties it first.

```json
{
  "documentType": "proposal",
  "summary": "…",
  "keyFindings": ["…"],
  "indicatorsMentioned": ["…"],
  "targetsMentioned": [{ "indicator": "…", "target": "…", "timeline": "…", "verified": true }],
  "recommendations": ["…"],
  "unverifiedFigures": ["…"],
  "model": "claude-haiku-5-5",
  "promptVersion": "document-analysis-v2",
  "analysedAt": "2026-10-12T09:30:00.000Z"
}
```

`documentType` is one of `proposal`, `logframe`, `budget`, `report`, `guidelines`, `other`. `model` is the served model. `verified` is true only when the target value is found in the document's redacted text by string match; `unverifiedFigures` lists numbers in the summary and key findings that the text does not contain (CLAUDE.md rule 6). Legacy rows (below) have neither; readers treat a missing `verified` as false. Document list and detail responses include `aiAnalysis` and `textLength` (characters of `parsedText`, 0 when none), not `parsedText` or `fileUrl`.

**`qualitativeSource`** (`boolean`, not null, default `false`) marks an FGD/KII transcript uploaded through the qualitative upload (POST /api/projects/:id/qualitative/upload). It is coded with its qualitative entry only and never sent to document analysis, framework generation or assessment summaries: every AI feature that reads documents filters on `qualitativeSource: false`. Transcripts can hold participants' own words and names, which patterns cannot remove. The Phase 3 SQL marks the transcripts that the old upload stored as documents: every document listed as `{"documentId": <id>, …}` in the `attachments` array of a qualitative entry **of the same project** (attachments of another shape, or of another project's entry, do not count). A transcript whose parsing failed under the old API got no entry and cannot be recognised; it stays `false`.

**`Framework.generationError`** (`text`, nullable) is set when AI generation of a framework version failed: a safe message for the user, never model output. Such a version is kept for the record but is never the project's current framework: **the current framework is the newest version with `generationError` empty**, and every read of "the latest framework" (routes and services) filters on `generationError: null`. Existing frameworks keep it empty.

**Legacy rows.** Before Phase 3 the parser appended the analysis to `parsedText` as `<text>\n\n---AI_ANALYSIS---\n<model answer>`: one marker, at the end. The Phase 3 SQL moves it, splitting at the **last** marker as the application's readers do (`stripAiAnalysis`, the assessment generator and the frontend use `lastIndexOf`), so a marker that the document's own text quotes stays in `parsedText` with the rest of that text:

| Text after the last marker | `aiAnalysis` becomes | `parsedText` becomes |
|---|---|---|
| a JSON object (no key repeated at any depth) | that object, with its original keys (`document_type`, `key_findings`, `indicators_mentioned`, `targets_mentioned`, …; no `model`, `promptVersion`, `analysedAt`, `verified`) | the text before the last marker, trailing whitespace trimmed |
| anything else: invalid JSON (e.g. an answer cut off), an array, a JSON value `jsonb` cannot store (`\u0000`), an object with a repeated key, an object nested too deeply to check (hundreds of levels) | `{ "legacyText": "<the text after the marker, as stored>" }` | the same |
| only whitespace | stays empty | the same |

A document that quotes the marker but never got an analysis is split the same way (the text after its last marker becomes `{legacyText}`), exactly as the readers have always treated it; nothing is lost.

Nothing is lost: the self-check in the SQL file (and `scripts/verify-migrations.sh`) proves, for every moved row, that the split point is the last marker, that the old `parsedText` is the new `parsedText` + whitespace + marker + what `aiAnalysis` holds (for an object, also that `jsonb` dropped no value: the number of values at every depth is counted independently of the duplicate-key check), that documents without the marker are untouched, that a marker left in `parsedText` belongs to a moved document's own text, and that exactly the transcripts above are marked. Readers in the API and the frontend accept both spellings of the keys, show nothing for `{legacyText}`, and still read the marker form in `parsedText`, which documents parsed by the old API after the SQL ran will have (§9 step 8).

## 9. Rolling out to a shared or Supabase database

Locally, `npx prisma db push` is enough. Shared databases get the reviewed SQL files, **in this order**; each one runs once:

| Order | File | Upgrades | Adds |
|---|---|---|---|
| 1 | `prisma/sql/2026-10-11_phase0_webhook_tokens.sql` | the schema at `df6c1f6` (what the shared Supabase database had until all three files were applied on 12 October 2026; step 5 checks where a database stands) | `WebhookToken`, RLS on it |
| 2 | `prisma/sql/2026-10-11_phase2_data_model.sql` | the schema at `022e09a` (Phase 0/1) | §1–6; RLS on `ResultNode` and `IndicatorLibraryEntry` |
| 3 | `prisma/sql/2026-10-12_phase3_ai_foundation.sql` | the schema at `642c474` (Phase 2) | §7–8 and `IndicatorLibraryEntry.embeddingModel` (§6); RLS on `AiCall` |

The Phase 2 file adds its enum values first (outside its transaction, safe to repeat); otherwise the Phase 2 and Phase 3 files each run in one transaction that starts with a guard and ends with a self-check, so any failure rolls everything back. The Phase 2 file refuses to run when `ResultNode` exists. The Phase 3 file refuses to run (and changes nothing) when `AiCall` already exists, when anything else it creates is left over from a half-done attempt (the `AiCallStatus` type, `Document.aiAnalysis`, `Document.qualitativeSource`, `Framework.generationError` or `IndicatorLibraryEntry.embeddingModel`; the message names it), or when `WebhookToken` (Phase 0) or `ResultNode` (Phase 2) is missing. Its transaction sets `lock_timeout` (step 6), creates `AiCallStatus` and `AiCall` with its indexes and foreign keys, adds the four columns, moves the legacy analyses and marks the legacy transcripts (§8), enables RLS on `AiCall` and checks the result: the table, columns and RLS are in place, no `generationError` or `embeddingModel` was invented, every moved row was split at its last marker and reproduces its old text (no JSON value dropped), a marker left in `parsedText` belongs to a moved document's own text, no other document got an analysis, and exactly the attached transcripts are marked. Its helper functions and work table live in `pg_temp` and disappear with the session.

**pgvector on Supabase.** The shared Raqib project has `vector` in `public` (checked 12 October 2026), which works as on a local database. Supabase installs new extensions in the `extensions` schema and gives its roles the search_path `"$user", public, extensions`, so `psql` and the SQL files find the `vector` type as they are (`scripts/verify-migrations.sh` §5 runs the whole rollout with this layout: the files apply, the extension stays in `extensions`, no drift). Check it with `psql "$DIRECT_URL" -Atc "SELECT extnamespace::regnamespace FROM pg_extension WHERE extname = 'vector'"` and `psql "$DIRECT_URL" -Atc 'SHOW search_path'`. If a session's search_path lacks the schema, the Phase 2 file stops with `type "vector" does not exist`: add `-c 'SET search_path TO public, extensions'` before `-f`. **The app's `DATABASE_URL` and `DIRECT_URL` must not hide the `extensions` schema:** do not add `?schema=public` to the Supabase URLs. With that parameter Prisma sets the search_path to `public` only, and a bare `::vector` cast fails (`type "vector" does not exist`), as does the `<=>` distance operator (`operator does not exist`); without it Prisma still uses `public` for its tables and keeps the role's search_path. The library embedding code also resolves the vector type's schema at runtime from the column itself, so its writes work either way; Phase 4 vector search must do the same (or write `OPERATOR(extensions.<=>)`). To check the app's view, `SHOW search_path` through `DATABASE_URL` must list `extensions`.

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
                ('rehearsal-legacy-bad',  E'Made-up report.\n\n---AI_ANALYSIS---\n{"summary": "cut off'),
                ('rehearsal-transcript',  E'Made-up FGD notes.\n\n---AI_ANALYSIS---\n{"summary":"Made-up FGD."}')) AS x(id, pt);
   -- the qualitative entry the old upload created for a transcript
   INSERT INTO "QualitativeEntry" (id, "projectId", "entryType", title, content, attachments)
   SELECT 'rehearsal-entry', d."projectId", 'fgd_transcript', 'Made-up FGD', 'Made-up FGD notes.',
          '[{"documentId":"rehearsal-transcript","fileName":"rehearsal-transcript.pdf"}]'
   FROM "Document" d WHERE d.id = 'rehearsal-transcript';
   ```
3. **Apply Phase 2 and Phase 3 on the branch** (from the `raqib-backend` checkout):
   `psql "$BRANCH_DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/2026-10-11_phase2_data_model.sql`
   `psql "$BRANCH_DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/2026-10-12_phase3_ai_foundation.sql`
   Each ends with `COMMIT`. If the Phase 2 file stops with `type "vector" does not exist`, see "pgvector on Supabase" above.
4. **Check the branch:**
   - no drift: `DATABASE_URL="$BRANCH_DIRECT_URL" npx prisma migrate diff --from-url "$BRANCH_DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` (exit code 0);
   - `SELECT count(*) FROM "Indicator" WHERE "resultId" IS NULL;` and `SELECT count(*) FROM "Document" WHERE strpos("parsedText", '---AI_ANALYSIS---') > 0;` both return 0;
   - `SELECT id, "parsedText", "aiAnalysis", "qualitativeSource" FROM "Document" WHERE id LIKE 'rehearsal-%';` shows the JSON objects and `{"legacyText": "{\"summary\": \"cut off"}`, `parsedText` without the analysis, and `qualitativeSource` true for `rehearsal-transcript` only;
   - `SELECT indexname FROM pg_indexes WHERE tablename = 'AiCall';` lists `AiCall_projectId_createdAt_idx` among the five indexes;
   - the extension and search_path checks under "pgvector on Supabase" above, through both URLs;
   - `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('WebhookToken', 'ResultNode', 'IndicatorLibraryEntry', 'AiCall');` shows `t` four times;
   - `npm run seed:library` (with `BRANCH_URL`/`BRANCH_DIRECT_URL`) reports 63 entries, and embeds them when `VOYAGE_API_KEY` is set; a second run creates, updates and embeds nothing;
   - point a test API (Phase 3 code, an Anthropic key) and the frontend at the branch, open the seed project's framework and upload a small made-up document: its analysis appears, and `SELECT feature, model, status, "inputTokens", "outputTokens", "estimatedCostUsd" FROM "AiCall" ORDER BY "createdAt" DESC LIMIT 5;` shows the calls.
5. **Back up the shared database** and check where it stands:
   `pg_dump "$DIRECT_URL" --schema=public -Fc --no-owner --no-privileges -f raqib-before-phase3.dump`
   `psql "$DIRECT_URL" -Atc 'SELECT to_regclass($$public."WebhookToken"$$), to_regclass($$public."ResultNode"$$), to_regclass($$public."AiCall"$$)'`
   An empty value means that file has not run yet; start with the first missing one. `SELECT count(*) FROM "Document" WHERE strpos("parsedText", '---AI_ANALYSIS---') > 0;` tells how many documents the Phase 3 file will move. The dump contains personal data: keep it private and delete it when no longer needed.
6. **Get approval** for the SQL and the branch results, then apply the missing files to the shared database in order, in a quiet period, with the same `psql` commands and `DIRECT_URL`. Each transaction takes seconds at current volumes. **Locks:** Phase 3 holds `ACCESS EXCLUSIVE` locks on `Document` (new columns; the data moves read every `parsedText` under the lock), `Framework` and `IndicatorLibraryEntry` (new columns), and locks `Organization` and `Project` (new foreign keys), until its `COMMIT`; reads and writes of those tables wait meanwhile, and the time grows with the amount of stored document text. The file starts with `SET LOCAL lock_timeout = '5s'`: if a lock is not granted within 5 seconds (for example behind a long report query), it stops with `canceling statement due to lock timeout`, rolls back and changes nothing, instead of making every request queue behind it. Wait for a quieter moment and run it again.
7. **Load the library:** `npm run seed:library` with the shared database's URLs (and `VOYAGE_API_KEY`, plus `VOYAGE_MODEL` when not the default, to embed the entries; each vector records its `embeddingModel`).
8. **Deploy the API, then the frontend — only after the SQL.** The Phase 3 API reads `Document.aiAnalysis` and writes `AiCall`; on a database without the Phase 3 SQL its document routes fail. The old API keeps working on the new schema (it ignores `AiCall` and the new columns); documents it parses before the deploy get the legacy marker in `parsedText`, which every reader still accepts; uploading such a document again moves it to the new form. Phase 2 notes still apply: projects created by the old API in the window get empty `sectors` (`UPDATE "Project" SET "sectors" = ARRAY["sector"] WHERE cardinality("sectors") = 0;`). Transcripts uploaded through the old qualitative upload in that window are not marked `qualitativeSource`; after the deploy, run the same marking again (safe to repeat; it only sets documents attached to an entry of their own project):
   ```sql
   UPDATE "Document" d SET "qualitativeSource" = true
   WHERE NOT d."qualitativeSource" AND EXISTS (
     SELECT 1 FROM "QualitativeEntry" q
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(q."attachments") = 'array' THEN q."attachments" ELSE '[]'::jsonb END) AS a(item)
     WHERE q."projectId" = d."projectId" AND jsonb_typeof(a.item) = 'object' AND a.item -> 'documentId' = to_jsonb(d."id"));
   ```
9. **Run the backfill** (owner decision of 12 October 2026), after the deploy. Documents parsed before Phase 3 still hold unredacted text (the SQL moves text, it does not rewrite it). With the shared database's URLs, as in step 7:
   ```bash
   pg_dump "$DIRECT_URL" --schema=public -Fc --no-owner --no-privileges -f raqib-before-backfill.dump   # a fresh backup
   npm run redact:backfill               # dry run: totals only, nothing is written
   npm run redact:backfill -- --apply    # writes the changes
   ```
   The dry run refuses ("Nothing was changed") when the Phase 3 SQL is missing. Record the totals both runs print (they hold counts and no text). If the summary says rows changed while the script ran, run it again; a second run changes nothing. Existing qualitative entries are included with `--include-qualitative` (owner approval of 12 October 2026: run `npm run redact:backfill -- --include-qualitative`, then `-- --apply --include-qualitative`). Details: `docs/AI.md` §9.
10. **Clean up:** delete the development branch and the worktree, record the dates in the status table of `docs/BUILD_GUIDE.md`, and delete the dumps according to the data-retention policy.

**Without development branches (Supabase free plan).** Branches need a paid plan. On the free plan, rehearse on a second, throwaway free project in the same region instead, with the same made-up data, and delete it afterwards. Two differences from a branch: the new project's `public` schema grants `anon` and `authenticated` access to new tables by default while the shared project grants none, so first run `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;` there; and on the shared project `vector` lives in `public`, so let `CREATE EXTENSION vector` put it there too. Check that the rehearsal starts from the same schema as the shared database by comparing fingerprints (md5 of the sorted column, enum, index and constraint lists of `public`, sorted with `COLLATE "C"`) on both.

**Through the SQL editor instead of `psql`** (the Supabase dashboard's SQL editor, or Claude through the Supabase connector): each run is sent as one query. The Phase 0 and Phase 3 files can be sent whole. The Phase 2 file cannot: its enum values must be committed before its transaction uses them, so send its `ALTER TYPE … ADD VALUE` lines first as one query, then the rest of the file from `BEGIN;` to `COMMIT;` as a second query.

**Rehearsal of 12 October 2026** (free plan, so a throwaway project `raqib-rehearsal`; dev seed from `022e09a` with a throwaway password, the three made-up legacy documents and the transcript entry from step 2; files sent through the SQL editor path above). Before: the rehearsal's `public` fingerprints matched the shared database's exactly (columns, enums, indexes, constraints; `vector` in `public`; no `anon` grants). After Phase 0, 2 and 3: each self-check passed; the fingerprints matched a local database taken through the same files with `psql`, which `prisma migrate diff` reports as identical to `prisma/schema.prisma`; every row of every table was unchanged in its old columns except the three legacy documents, whose analyses moved as step 4 expects (`{legacyText}` for the cut-off one, `qualitativeSource` only on the transcript); 0 indicators without a result; RLS on all four new tables and no `anon` access; Supabase's security advisor reported only "RLS enabled, no policy" (intended: nothing is readable through the Data API) and the existing `vector` extension in `public`; sending the Phase 3 file again was refused ("already applied") and changed nothing.

**Shared database, 12 October 2026** (owner's approval the same day; files sent through the SQL editor path above, with nothing else connected). Before: a copy of every `public` table in a private schema `backup_20261012` inside the same database (the free plan has no downloadable backups; the schema has no `anon`/`authenticated` access and is not exposed by the Data API), checked row for row. Then the Phase 0 file, the Phase 2 enum values, the Phase 2 transaction and the Phase 3 file; every self-check passed. After: the `public` fingerprints match the local reference that `prisma migrate diff` reports as identical to `prisma/schema.prisma`; every row of every table is unchanged in its old columns compared with `backup_20261012` (no legacy documents or transcripts were stored, so nothing moved); 12 placeholder results, all 36 indicators linked; RLS on all four new tables and no `anon` access; the security advisor shows the same two notices as the rehearsal; a second Phase 2 run was refused. Still to do at the first deploy: `npm run seed:library` (step 7) and the backfill with `--include-qualitative` (step 9). Delete `backup_20261012` only with the owner's approval, once the deployed app has been checked.

**Rolling back.** Prefer rolling forward: the changes are additive and the previous API version runs on the new schema, so reverting the code is enough. One visible effect: the pre-Phase 3 frontend reads document analyses only from `parsedText`, so it shows none for moved documents until the Phase 3 code is back (the analyses stay in `aiAnalysis`). The pre-Phase 3 API also ignores `qualitativeSource` and `generationError`: it would again send transcripts to framework generation and could pick a failed framework version as the latest, so keep a rollback short. Removing tables, columns, enum values or moving analyses back would need a separate reviewed script and explicit approval (no drops without approval); the dump from step 5 is the last resort. The backfill (step 9) rewrites text in place and can only be undone from its own dump.

## 10. Verifying the SQL locally

`npm run verify:migration` runs `scripts/verify-migrations.sh` (needs `npm ci`, git history with the revisions below, and a local Postgres with pgvector). It only uses localhost, and refuses URLs with a `host=`/`hostaddr=` parameter or a comma-separated host list unless `VERIFY_ALLOW_NON_LOCAL=1`. It creates throwaway databases named `raqib_mverify_<kind>_<time>_<pid>_<random>_test`, which cannot clash with anyone's test databases (`raqib_test`, `raqib_<key>_test`), and drops only those at the end (`KEEP_DBS=1` keeps them). It ends with `PASS <n> checks passed, 0 failed` or exits 1.

0. **Static:** no file contains a `DROP` statement; the Phase 3 file is one transaction whose first statement after `BEGIN` sets `lock_timeout`.
1. **Fresh database** (`prisma db push` of the current schema): no drift; the Phase 3 file is refused there ("already applied") without changes; the app's Prisma client creates, reads and deletes `AiCall` rows (defaults, `numeric(12,6)` cost, relations, the per-organisation and per-project queries) and queries the new columns as the app does.
2. **Empty database:** the Phase 3 file is refused ("needs the Phase 0 SQL first") and creates nothing; with a leftover `AiCallStatus` type it is refused as "already partly applied".
   **Partly applied:** on copies of a database at the Phase 2 schema (`642c474`), each leftover alone — `Document.aiAnalysis` (without `AiCall`), `Document.qualitativeSource`, `Framework.generationError`, `IndicatorLibraryEntry.embeddingModel`, the `AiCallStatus` type — makes the file refuse as "already partly applied", naming the leftover, with the schema unchanged.
3. **Copy of the seed** at `022e09a` (old schema, old Prisma client, old seed) plus synthetic fixtures — frameworks and indicators for the Phase 2 edge cases, a beneficiary, 20 documents and 6 qualitative entries. 15 documents are in the legacy format (valid JSON, cut-off JSON, an array, repeated keys at the top and deep inside, JSON nested 600 levels deep, the marker quoted by the document's own text before the appended analysis, a marker quoted by a document that got no analysis, overlapping markers, only whitespace after the marker, Arabic text, the marker at the very start, `\u0000`, CRLF line ends, a transcript from the old qualitative upload); 5 are without (plain text with trailing newlines, no text, marker look-alikes that a `LIKE` pattern would catch, transcripts). The qualitative entries attach documents as the old upload did, as the second item of a list, from another project, and in shapes that must not count (an object, bare strings, a number, no attachments):
   - the Phase 3 file is refused before Phase 2 ("needs the Phase 2 SQL first") without changes;
   - **Phase 2:** every Phase 2 check (row counts and checksums of every table, results chain links and hierarchy, unique result codes, sectors, provenance, RLS, enum values, the app's Prisma client, a refused second run) and no drift against the Phase 2 schema (`642c474`);
   - **Phase 3, runs that must roll back** (each on its own copy of the database, every column of every table and the schema compared before and after): with a second session holding a lock on `Document`, the file stops with "lock timeout" after about 5 seconds; three copies of the file with a deliberate bug — duplicate-key check skipped, split at the first marker, transcripts not marked — are stopped by its self-check; a copy without the exception handler of the duplicate-key check fails on the 600-level fixture ("stack depth limit exceeded"), which proves that fixture exercises that path;
   - **Phase 3:** row counts and checksums of every column of every table unchanged except `Document.parsedText`; `AiCall` columns, types, defaults, enum values, the four indexes (with `AiCall_projectId_createdAt_idx`) and foreign keys exactly as in `prisma/schema.prisma`, and their behaviour (rename cascades, deletes set the link to NULL) in a rolled-back transaction; RLS on `AiCall` with no policies; `Document.aiAnalysis` is `jsonb`, the three other columns have their types and defaults and no invented values; no `AiCall` rows invented; no `pg_temp` helper left behind; each document fixture moved and marked exactly as §8 says; only the document that quotes the marker still contains it; every document without the marker untouched and nothing lost for every legacy one (the last marker found here with a regular expression, independently of the SQL file); no drift against `prisma/schema.prisma`; the app's Prisma client writes and reads `AiCall` rows and reads the moved data; a second run refused without changes.
4. **Rollout order** on the schema the shared database has today (`df6c1f6`): the Phase 3 file is refused before Phase 0; the Phase 0, Phase 2 and Phase 3 files apply in order; RLS is on for all four new tables; no drift against `prisma/schema.prisma`.
5. **Supabase layout:** the same rollout on a database where pgvector lives in an `extensions` schema and the search_path is `"$user", public, extensions`: the files apply, the extension stays in `extensions` (no `vector` type in `public`), no drift, the app's Prisma client works; with `search_path = public` (what `?schema=public` sets) a bare `::vector` cast and the bare `<=>` operator fail, while the column's own type (`extensions.vector`, read from the catalogue) stores a vector and `OPERATOR(extensions.<=>)` compares it (rolled back).

CI runs the script in the `migrations` job of `.github/workflows/ci.yml` (a pgvector service container, full git history for the revisions below), so a change to `prisma/schema.prisma` without the matching SQL, or a broken SQL file, fails the pull request.

The revisions can be changed with `BASE_REV`, `PHASE2_REV` and `PRE_PHASE0_REV`, the server with `VERIFY_PG_BASE_URL`.
