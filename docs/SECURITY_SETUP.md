# Security setup

What changed in Phase 0 (and the AI rules added in Phase 3 and the KPI Assistant of Phase 4, §6) and what to do once per environment.

## 1. Environment variables

The server now refuses to start when required settings are missing or weak, and prints which ones:

| Variable | Rule |
|---|---|
| `DATABASE_URL` | required |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | required, at least 32 characters each (`openssl rand -hex 32`) |
| `ANTHROPIC_API_KEY` | required |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | required in production (document storage) |
| `CORS_ORIGINS` | extra browser origins, comma-separated; `APP_URL` is always allowed |
| `AI_MODEL_MAIN` | optional, default `claude-sonnet-5-5`; the only place a main-tier model id is set |
| `AI_MODEL_FAST` | optional, default `claude-haiku-5-5`; the only place a fast-tier model id is set |
| `AI_REQUEST_TIMEOUT_MS` | optional, default `60000`, at least `1000`; timeout per AI request (long generations pass more) |
| `AI_MAX_RETRIES` | optional, default `3`, from 0 to 10; retries after rate limits, overloads, server and network errors |
| `AI_REFUSAL_FALLBACK` | optional, `default` (the default) or `off`; `default` lets Anthropic re-run a refused request on its fallback model (Sonnet 5.5, Opus 5, Opus 5.5 only) |
| `AI_CALL_RETENTION_MONTHS` | optional, default `24`, from 1 to 120; months an `AiCall` log row is kept before the worker's nightly job deletes it |
| `VOYAGE_API_KEY` | optional secret; embeddings for the indicator library and, from Phase 4, the KPI Assistant's query texts. Without it nothing is sent to Voyage and search uses keywords |
| `VOYAGE_MODEL` | optional, default `voyage-4` |
| `AI_ORG_DAILY_BUDGET_USD` | optional, default `20` (set by the owner on 13 October 2026), a number of US dollars, at least 0; an organisation's AI spend over the last 24 hours (all AI features, from the `AiCall` log). KPI suggestion requests answer 429 `budget_reached` once it is spent; calls of a model without a price in `models.ts` count at the highest known rates (the API warns at startup); `0` turns the check off |
| `PRISMA_LOG_QUERIES` | optional, `0` (the default) or `1`; `1` logs every SQL statement for local debugging (placeholders, not values) |

Blank values (`NAME=`) for the optional AI settings use the default. Changing `JWT_SECRET` signs everyone out once. See `.env.example` for the full list.

## 2. Document storage

Documents are no longer served from a public `/uploads` folder.

- **Production / staging:** files go to a private Supabase Storage bucket (`SUPABASE_STORAGE_BUCKET`, default `documents`). Create it once with `npm run storage:setup` (it refuses to continue if the bucket is public).
- **Local development:** without Supabase settings, files are kept in `LOCAL_STORAGE_DIR` (default `storage/`, git-ignored) and are never served statically.
- **Downloading:** `GET /api/documents/:id/download` checks that the user belongs to the document's organisation and returns `{ url, fileName, expiresAt }`. The URL works for 5 minutes.
- **Existing files:** documents uploaded before Phase 0 still point at `/uploads/...`. Run `npm run storage:migrate` to see what would move, then `npm run storage:migrate -- --apply` to copy them into the bucket. Delete the old `uploads/` folder only after checking downloads work.

Uploads are limited to 25 MB and to PDF, Word (`.docx`) and Excel (`.xlsx`) files. Word 97–2003 (`.doc`) files are refused with "Word 97–2003 (.doc) files cannot be read. Save it as .docx or a text-based PDF and upload it again." (the parser cannot read them). The file content must match its extension. Legacy `.xls` files are no longer accepted (the old spreadsheet library had unfixed security issues); save them as `.xlsx`.

## 3. Webhooks (KoboToolbox, Manasati)

Every webhook call needs an organisation webhook token, and can only write to that organisation's projects.

1. An org admin creates a token: `POST /api/organizations/:orgId/webhook-tokens`. The response contains the token **once**; only a hash is stored. Data imported through the token is attributed to the admin who created it.
2. In KoboToolbox: *Project → Settings → REST Services → Register a new service*, endpoint `https://<api-host>/api/webhooks/kobotoolbox`, and add a custom HTTP header `X-Raqib-Webhook-Token: <token>`.
3. Optional signing: senders that can sign requests add `X-Raqib-Signature: sha256=<hex HMAC-SHA256 of the raw body>` using `WEBHOOK_SECRET`. A signature that is present must be valid.
4. List tokens with `GET /api/organizations/:orgId/webhook-tokens`; revoke with `DELETE /api/organizations/:orgId/webhook-tokens/:tokenId`.

Rejected calls are logged as `[Webhook] Rejected {...}` with the reason and IP, never the token.

## 4. Database change

Phase 0 adds one table, `WebhookToken`. The reviewed SQL is in `prisma/sql/2026-10-11_phase0_webhook_tokens.sql` (additive only, and it enables row level security on the new table so Supabase's public API cannot read it). Apply it to a Supabase development branch first, then to the shared database.

Phase 2 and Phase 3 add more reviewed SQL (Phase 3: the `AiCall` table with row level security and a project index, `Document.aiAnalysis`, `Document.qualitativeSource`, `Framework.generationError` and `IndicatorLibraryEntry.embeddingModel`). On Supabase, do not add `?schema=public` to `DATABASE_URL`: Prisma would then hide the `extensions` schema where pgvector lives. Apply the files in order (Phase 0, Phase 2, Phase 3) as described in `docs/DATA_MODEL.md` §9.

## 5. Other protections

- Security headers (`helmet`), CORS limited to configured origins.
- Rate limits: 300 requests/minute per IP overall; 30 per 15 minutes on `/api/auth/*`; 60 AI requests/hour per user; 120 KPI suggestion requests/hour per organisation on top of that; 240 KPI run polls/minute per user (they do not count towards the per-IP limit); 120 webhook calls/minute per IP.
- Every route that takes an id checks the caller's organisation through `src/middleware/access.ts`; other organisations' records answer 404. Ids passed in a request body (indicator, assessment) must belong to the same project.
- Access tokens must carry an organisation and a role; reset tokens are refused. `authenticate` validates the verified token payload with zod (user id, email, organisation id, a known role, full name) and refuses any token with a `purpose` claim (401); the access helpers answer 401 when the signed-in user has no organisation. Follow-ups: single-use reset links, and a separate audience or secret for reset tokens (RFC 8725 §3.12).
- Org admins can no longer grant the `platform_admin` role.
- Every write, delete and AI route checks the role; donor viewers are read-only and never receive beneficiaries' personal data (§8).
- The seed refuses to run in production and needs `SEED_PASSWORD` outside development.

## 6. AI providers and personal data (Phase 3, Phase 4)

Raqib sends text to Anthropic (all AI features) and, when `VOYAGE_API_KEY` is set, to Voyage AI (embeddings). Models receive aggregates and organisational text only (CLAUDE.md rule 5). Details per feature: `docs/AI.md` §9.

**Sent to Anthropic:** project metadata (name, sectors, donor, dates, target beneficiaries, geographic scope, the redacted description); redacted document text (at most 8 000 characters per document for the framework structure step, 12 000 for document analysis) and redacted file names; indicator texts, definitions, baselines, targets and aggregated values with areas and disaggregated counts; redacted qualitative entries (titles, content, themes); indicator library entries. The KPI Assistant (Phase 4; framework generation's indicator step uses it too) sends the redacted project fields above, the redacted results chain (codes, statements, Arabic statements), the redacted names of the framework's indicators and pending suggestions, at most 40 redacted document sentences that hold a number (each at most 300 characters, with the redacted file name; sentences that held a phone number, ID number or email address are left out), up to 40 library candidates, and the organisation's preferred collection methods. It never sends whole documents, reject notes or user names.

**Sent to Voyage:** indicator library text only (name, Arabic name, definition, tags); from Phase 4 also the redacted English result statements (to rank library candidates) and the redacted English names of suggested and existing indicators (to find near-duplicates). Never personal data.

**Saved from the KPI Assistant.** Every free-text field of a suggestion the model writes (name, Arabic name, definition, means of verification, rationale, notes, custom reason) is redacted before it is stored; sentences with numbers that no source supports are removed. A reject note is redacted when it is saved and is never sent to a model. Document file names are redacted (and clipped to 200 characters) wherever a suggestion cites them. Suggestions and runs are kept as the organisation's history (never pruned); they hold no prompt text.

**Cost limits.** At most 40 results and 20 model calls per KPI run, at most 6 KPI model calls at a time per API process, 120 KPI requests per hour per organisation and the organisation daily budget `AI_ORG_DAILY_BUDGET_USD` (§1). Runs are refused on archived projects. Without a real `ANTHROPIC_API_KEY` a KPI suggestion request answers 503 `ai_not_configured` before a run is created or anything is charged.

**KPI evaluation (`npm run eval:kpi`).** The evaluation never uses a database: before it loads the configuration it always replaces `DATABASE_URL` and `DIRECT_URL` with an unusable placeholder (`postgresql://unused:unused@127.0.0.1:9/unused_eval`), whatever `.env`, the shell or CI set, checks that the placeholder is in force (it refuses otherwise), keeps the AiCall records in memory and reads the library from `knowledge/indicator-library.json`. The real run refuses without a real `ANTHROPIC_API_KEY` (missing, placeholder or not `sk-ant-…`), without `--yes`, in production, and with `--embeddings` but no `VOYAGE_API_KEY`; it stops starting new cases once `--max-usd` (default US$3) is spent. `--fake` uses a deterministic fake model with a placeholder key and an unreachable API address: no key, no network, no cost. The cases are fictional; the report in `eval-results/` (git-ignored) holds ids, numbers and the validated suggestions, never prompt text.

**Never sent:** beneficiary records, user names and email addresses, passwords, tokens and keys, data point notes, original files.

**Personal data in documents.** Uploaded documents stay in the private bucket. The parser (`src/services/ai/documentParser.ts`) extracts the text and runs `redactPersonalData` (`src/services/ai/redact.ts`) before anything is stored or sent to a model. It removes email addresses (any script), phone numbers (+/00 international numbers, 970/972 mobiles and landlines, local 05X mobiles and 0[2489] landlines, in ASCII or Arabic digits, also inside PDF tables) and 9-digit ID numbers, replacing them with `[email removed]`, `[phone removed]` and `[ID number removed]`. `Document.parsedText` holds only redacted text. The model sees at most the first 12 000 characters plus the redacted file name. The analysis is stored in `Document.aiAnalysis`, never appended to `parsedText`. Qualitative entries are redacted the same way **when they are saved** (owner decision of 12 October 2026): the title, content, location and facilitator of typed notes, the typed title, location and facilitator of a transcript upload, and KoboToolbox qualitative submissions; `POST /api/projects/:id/qualitative` returns the counts as `redactions: { phone, idNumber, email }`, and the log line holds the entry id and the counts only. Qualitative entries, project descriptions, geographic scope, areas and data point text are redacted again before a prompt is built, and model output is redacted again before it is stored. FGD/KII transcripts uploaded through the qualitative upload are marked `qualitativeSource` and are used only for qualitative coding, never for document analysis, frameworks or assessments. **No API response returns `parsedText` or the storage key `fileUrl`**; document responses carry `textLength` instead.

**Limits.** Names and street addresses cannot be detected by patterns. The prompts forbid the model from writing them, but text that staff upload or type is sent as it is. **Staff must not put names, addresses or other identifying details of beneficiaries into documents, transcripts, notes or descriptions that Raqib analyses.** Documents parsed before Phase 3 keep unredacted text at rest until they are parsed again or the one-off backfill (owner decision of 12 October 2026) has run; until then the AI services redact it again before every model call, and the API never returns it. The backfill procedure, once per shared database after the Phase 3 SQL and the deploy (`docs/DATA_MODEL.md` §9, step "Run the backfill"):

1. Take a backup of the database (`pg_dump`; it contains personal data, so keep it private and delete it when no longer needed).
2. `npm run redact:backfill`: a dry run that prints totals (documents, and counts of phone numbers, ID numbers and email addresses) and writes nothing. It refuses when the Phase 3 SQL is missing.
3. `npm run redact:backfill -- --apply`: redacts `Document.parsedText` and the string values of `Document.aiAnalysis`. A row changed while the script runs is skipped and the summary asks to run it again; a second run changes nothing.

Existing qualitative entries are included with `--include-qualitative`; the owner approved this on 12 October 2026, so the shared database's run uses it. The script needs only `DATABASE_URL` and prints totals and row ids (`--verbose`), never text or file names. File names are kept as uploaded (downloads need them); a prompt that names a file gets the redacted name. Details: `docs/AI.md` §9.

**Logs.** Every AI call writes one `AiCall` row (feature, model, prompt versions, status, token counts, latency, estimated cost, organisation and project ids) and one console line with the same numbers. Neither ever holds prompt text, document text, model answers or error messages. AI job failures are logged with the AiError message or the error class name only (`safeErrorSummary`), never database error text. The same holds for every API error (`errorHandler`: the API's own messages, otherwise the class name and Prisma code, plus stack frames outside production) and for unhandled errors; Prisma's own `error` log level is off, because Prisma prints a failed query with the values it was given (a whole qualitative entry, for example). Qualitative entries are checked before they are saved (entry type, participants, date), so a bad value gets a 400 that names the field and never reaches the database. The parser logs document ids, lengths and redaction counts only; saving a qualitative entry logs its id and redaction counts only. `AiCall` rows are deleted after 24 months (`AI_CALL_RETENTION_MONTHS`) by a nightly worker job at 03:30 Asia/Hebron; `npm run ai-calls:prune` runs it by hand (dry run unless `-- --apply`).

**Anthropic API key.** `ANTHROPIC_API_KEY` is a secret like the JWT secrets: keep it in the environment, never in code, tests or logs. Tests point the SDK at an unreachable local address, so they can never call the real API; only `npm run ai:smoke` and `npm run eval:kpi -- --yes` do.

## 7. Tests

```bash
# Unit tests run anywhere; integration tests need a disposable Postgres with pgvector
# whose database name contains "test" (all data in it is deleted).
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/raqib_test npx prisma db push --skip-generate
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/raqib_test npm test
```

`tests/isolation.test.ts` lists every route that takes an id and fails if a new one is added without an isolation check. `tests/roles.test.ts` checks the role decision for every route (§8).

The KPI evaluation's unit tests (`tests/kpiEval.test.ts`) and `npm run eval:kpi -- --fake` need no key, no network and no database (CI runs the fake evaluation after the tests). Tests of the KPI Assistant use fakes for the model (a fake `ModelCaller` or a fake SDK behind the real client) and for Voyage; none calls a real provider.

## 8. Roles and personal data

Owner decision of 13 October 2026: donor viewers are read-only and never receive beneficiaries' personal data. Organisation staff keep the access they had. The rules follow humanitarian data-protection practice (sources at the end of this section): donors get results, not identities; showing data on a screen counts as sharing; access is need-to-know and deny by default; removing names is not enough, so small counts are hidden and other counts rounded; donors receive no respondent-level survey rows (KoboToolbox submissions) and no unreviewed AI output; donor responses are built from explicit field lists (privacy by default).

### 8.1 Roles

| Role | Who | Writes | AI features | Beneficiary personal data |
|---|---|---|---|---|
| `platform_admin` | Raqib staff, limited to their own organisation by the access helpers | yes (plus the template library) | yes | yes |
| `org_admin` | Organisation administrator | yes (plus organisation settings, users, approvals, project create and archive) | yes | yes |
| `me_officer` | M&E officer | yes (projects, frameworks, indicators, data, beneficiaries, documents, qualitative) | yes | yes |
| `donor_viewer` | A donor's representative given read access by the organisation | **none** | **none** | **never** |

`src/middleware/roles.ts` defines `STAFF_ROLES` (org_admin, platform_admin, me_officer), `ADMIN_ROLES` (org_admin, platform_admin), `PLATFORM_ROLES` (platform_admin) and `hasStaffRole(user)`. `hasStaffRole` denies by default: donor_viewer, a missing role or any unknown value gets the donor view. `authorize(...roles)` needs at least one role (the old "empty list allows everyone" form is gone) and always comes straight after `authenticate`, before multer and any rate limiter, so a refused upload is never read. Access tokens must carry an organisation and a role; reset tokens are refused (§5). Access tokens last 15 minutes, so a role change takes effect within 15 minutes. The web app reads the role from the same access token (frontend `src/lib/session.ts`), so its screens follow a role change at the next token refresh, without signing in again.

### 8.2 Route matrix

The authoritative list of all 90 routes (81 before Phase 4, plus the 2 report publishing routes of the donor-access pull request and the 7 KPI Assistant routes) is `ROLE_MATRIX` in `tests/roleMatrix.ts`. `tests/roles.test.ts` (no database) fails when a route has no entry, when an entry has no route, or when a route's guard differs from its entry. It also checks that:

- every layer of the app that is not a route or a router is on a reviewed list (by identity, or by name for the global middleware created in `src/app.ts`). The walk enters every layer that has its own stack, whatever its name, so an endpoint written as `app.use(path, handler)`, a mounted sub-app, a router behind a wrapper function or a static mount fails the test instead of escaping the matrix;
- every non-GET route refuses donor viewers, except a reviewed allowlist of 8 (sign-in, refresh, forgot and reset password, the two webhooks, and marking one's own notifications);
- every AI route refuses donor viewers;
- every KPI Assistant route (`KPI_ROUTES`: POST and GET `/projects/:id/kpi-suggestions`, `GET /kpi-suggestion-runs/:id`, accept, reject, `GET /frameworks/:id/indicator-quality`, `GET /kpi-assistant/status` and the alternatives alias `POST /indicators/:id/alternative`) carries exactly `KPI_ROLES`, which is `STAFF_ROLES`, and a donor viewer gets 403 on each;
- a donor viewer and an M&E officer on admin routes get 403, and a reset token or a token with an unknown role gets 401.

Two integration tests do not rely on the lists: `tests/donorAi.test.ts` calls every route open to donor viewers (`all` and `self`) with real ids through the real AI services, with a fake model client, and fails if any request reaches the model (it also checks that the same fixture does reach the model on a staff AI route); `tests/donorAccess.test.ts` scans the answer of every GET route open to donor viewers, `self` routes included, for the fixture's personal data.

| Resource | Donor viewers | Staff only | Admins only (org_admin, platform_admin) |
|---|---|---|---|
| Organisation, users | own organisation profile | | edit organisation, webhook tokens, users |
| Projects | list, project page (donor-visible documents only; counts of what donors see), export (donor export, §8.3) | edit | create, archive |
| Documents | donor-visible documents without AI analysis or uploader name: list, download, status (others answer 404) | upload (AI analysis), delete | |
| Frameworks, results, indicators | read, approved indicators only (Phase 4, `src/services/indicators/visibility.ts`) | generate (AI), manual framework, add, edit, delete, alternatives (AI) | approve |
| KPI Assistant (Phase 4) | none: suggestions never reach donor viewers (kpi-assistant-spec §A1) | suggest (AI), list, poll a run, accept, reject, indicator quality, status | |
| Assessments | list and status without the AI text, price or report location; the AI assessment report answers `report: null`; price estimate | request assessment (AI) | update assessment |
| Reports | published reports only (drafts answer 404) | generate report (AI) | publish a finished report, take it back to draft |
| Data points | staff-entered results without notes, attachments, author or unlisted areas; KoboToolbox submissions as published monthly aggregates only, never counted | add, bulk import | |
| Qualitative entries | type, month and number of participants only | add, upload, AI coding | |
| Dashboard | project dashboard (projected as for data points), overview | AI risk analysis | |
| Beneficiaries | the summary (`/beneficiaries/stats`): small counts hidden, other counts rounded | list, detail, register, edit, services, register CSV | |
| Exports | indicators export as for data points | beneficiary register | |
| Templates | read | | create, import, edit, delete: platform_admin only |

The AI routes are document upload, framework generation, KPI suggestions and indicator alternatives (the KPI Assistant), assessment requests, qualitative create, upload and coding, report generation and the risk analysis. None is open to donor viewers. The AI risk analysis is a staff tool: it runs a model on every request and its output is not reviewed; project staff share their conclusions with donors in reports. This supersedes the Phase 4 design, which kept it open to donor viewers on approved indicators only (SDA-06); the donor-only `approvedOnly` option of `analyzeProjectRisks` was removed with it (review finding TQ-08). Donors receive no unreviewed AI output from the routes listed here (§8.3), with the exceptions in §8.6.

### 8.3 What donor viewers receive

Donor responses are built from explicit field lists in `src/services/privacy/donorView.ts` and `src/services/beneficiaries/donorSummary.ts`, applied whenever `hasStaffRole(req.user)` is false; never from raw rows, so a column added later does not reach donors by accident.

- **Beneficiaries.** Never names (Latin or Arabic), phone numbers, ID numbers, exact age, location text, household size, tags, registration date or status per person, beneficiary ids, or service descriptions and notes. The list (which can be searched by ID number), the detail, the register CSV and every beneficiary write answer 403. Donors get `DonorBeneficiarySummary` instead, from one function, on the stats route and as `beneficiarySummary` in the export (counts protected as in §8.4).
- **Project export** (`GET /api/projects/:id/export`). Staff: today's body plus `audience: 'staff'`. Donors: `audience: 'donor'`, `personalData: 'excluded'`, no `beneficiaries` key at all, the beneficiary summary, data points and survey aggregates as below, qualitative entries as below, assessments as below, and the project, frameworks and indicator reference sheets as staff see them. Beneficiary rows are read only after the role check.
- **Assessments** (export, `GET /projects/:id/assessments`, `GET /assessments/:id/report`). Donors get `id, projectId, type, status, requestedAt, deliveredAt, sampleSize, methodsIncluded` (collection methods only). Never `scopeDescription`, which holds the AI assessment: the model writes it from transcript excerpts, and names are kept out only by a prompt instruction (pattern redaction removes phone numbers, ID numbers and email addresses, not names). Never the price or the report location. The AI assessment report answers `report: null` to donors: assessments have no review step yet.
- **Reports.** Donors see published reports only, from an explicit field list (never `fileUrl`); drafts answer 404, like another organisation's id. Every report starts as a draft and holds an unreviewed AI narrative; the draft that an assessment creates has a "Beneficiary Voices" section drawn from transcripts. **Org admins and platform admins publish** (`PATCH /api/reports/:id/publish`): publishing is the review that lets a report reach donors, so the admin reads the narrative first (redaction removes phone numbers, ID numbers and email addresses, not names or quotes). The web app offers Publish only inside the report's reading view, which shows the narrative in a sandboxed frame (no scripts, no network requests); donor viewers read published reports in the same view. Only a finished report can be published, one whose narrative or file exists; a report still being generated, or whose generation failed, answers 409. `PATCH /api/reports/:id/unpublish` takes a report back to draft, and donors then get 404 for it again. M&E officers and donor viewers get 403 on both routes, and another organisation's report answers 404. Both answer with the report as staff see it (`GET /api/reports/:id`). When a draft becomes published, the organisation's donor viewers get an in-app notification (the existing `report_generated` type, in each viewer's language) with the report title and project name only, linking to the project's Reports tab (`/projects/:id?tab=reports`); publishing an already published report changes nothing and notifies nobody again, and unpublishing notifies nobody. Code: `src/routes/reports.ts`, `src/services/reports/publication.ts`; tests: `tests/reportPublishing.test.ts`.
- **Qualitative entries.** Donors get `id, projectId, assessmentId, entryType, monthConducted ('YYYY-MM'), participants`: that an FGD, KII or other entry took place, its month and the number of participants. Never the title, content, facilitator, location, attachments, exact date or time (`createdAt` is the time a KoboToolbox submission arrived, close to the interview), and no AI output (themes, sentiment, linked indicators), because AI coding is not reviewed. Reasons: content is redacted only for phone numbers, ID numbers and email addresses, so names and quotes remain; KoboToolbox entries hold the whole submission and exact GPS; attachment and automatic titles hold original file names; facilitator names identify field staff in a conflict setting. UNEG's Ethical Guidelines (2020) ask evaluators to protect participants' identity and confidentiality throughout data collection, storage, analysis and reporting, to ensure non-attribution of data to participants, and to specify who has access to the data (pp. 19, 29, 31); informed consent should explain how the information will be used (p. 32). FGD and KII participants usually agree to their statements being used by the evaluation team, not shared beyond it: that is Raqib's reasoning, not a UNEG rule. The OCHA oPt protocol classes AAP messages and household-level raw data as Severe; ICRC protection standards ask to conceal sources, identities, dates and places.
- **Documents.** Donors see and download only `proposal`, `logframe`, `theory_of_change`, `baseline_report`, `donor_guidelines` and `budget`, and never transcripts (`qualitativeSource`), with `aiAnalysis` and `uploader` set to null (the analysis is not reviewed; field staff are not named). Original files are never redacted, `other` is where registers, attendance lists and photos end up, and transcripts are raw FGD/KII records. Hidden documents answer 404 "Document not found", the same answer as another organisation's id, so types cannot be probed. Delete is staff only (owner decision D3).
- **Data points.** A KoboToolbox submission holds one respondent's answers: the webhook stores one row per submission and mapped field, with `dataSource: 'KoboToolbox'` and the household's GPS (a row typed with that source counts the same; `isRespondentLevel` in `donorView.ts`). The OCHA oPt protocol classes respondent-level raw survey data as Severe. Donors never get these rows: they get `surveyAggregates`, one per indicator and calendar month, with the number of submissions (a count, §8.4) and the sum (count units), the number of yes answers (yes/no answers, also for a percent unit coded 0/100) or the mean (other units; only of 8 answers or more, HESA's rule for averages, to one decimal place). A sum or a number of yes answers is a count: 1 to 4 hidden, otherwise rounded to the nearest 5.
  - **Published months only, never updated.** A month's aggregates reach donors 14 days after the month ends (00:00 UTC on the 15th of the next month, `surveyReleaseAt`), built from the submissions received before then; submissions that arrive later stay with staff. A figure that changed with every submission would give away each household's answer by differencing (the mean before and after one submission, multiplied by the number of submissions), so a published figure never changes.
  - **Never counted.** The record counts donors see (`_count.dataPoints` on the project list, the project page and every framework indicator list; `dataPointCount` and `geographic` on the dashboards) leave KoboToolbox rows out (`donorDataPointWhere`): an exact count would be the exact number of submissions, which undoes the hiding and rounding of `submissions` and, with a mean, gives away a single answer. The same counts leave out documents donors cannot see, and `_count.reports` and `reportCount` count published reports only.
  - **Results staff enter** (from records, reviews and other secondary sources, and household-survey results entered as one row per survey round, such as "62 % of households") are indicator values and reach donors as such, keeping `id, indicatorId, assessmentId, value, collectionDate, collectionMethod, dataSource, geographicArea, breakdown, createdAt` (and the indicator text on the dashboard). Notes (free text, never redacted), attachments and the author are left out. An indicator's `currentValue` is never set from a KoboToolbox row (single entry and bulk import).
  - This applies to `GET /indicators/:id/data` (whose trend and `count` then follow what donors see), the dashboard (`trends`, from the 10 most recent rows donors are shown, and `recentActivity`), the project export and the indicators export.
- **Areas.** Donors see an area only when it is one of the two regions or 16 governorates in `src/services/privacy/places.ts` (one list for the API, English and Arabic with common spellings, returned under the listed name); anything else becomes null. So villages, camps, streets, coordinates in any format and plus codes never reach donors: KoboToolbox stores each household's exact GPS, which is personal data and finer than a governorate. The dashboard groups areas by listed place whatever the spelling or script (`area` is the English name, `areaAr` the Arabic one) and folds unlisted areas into one `area: null` group; the beneficiary summary's governorate table puts unlisted places into "other" whatever their size.
- **Unchanged for donors** (no beneficiary personal data; see §8.6): project list and budgets, assessment price estimates, indicator values and staff-entered breakdowns, frameworks and their results chain, the organisation profile. Indicators: approved ones only, everywhere (Phase 4: framework, project page, exports, dashboards, indicator data; `indicatorVisibilityWhere` denies by default, so any caller without a staff role sees approved indicators only). KPI suggestions never reach donor viewers.

### 8.4 Disclosure control for counts

`src/services/privacy/disclosure.ts` (pure, unit tested in `tests/disclosure.test.ts`) protects every count in the beneficiary summary and in the survey aggregates. It follows the HESA Standard Rounding Methodology (counts of people rounded to the nearest multiple of 5 after all calculations, so tables may not add up; averages of 7 or fewer people not published; HESA's stated reason is that rounding every figure "prevents multiple tables being used to identify small numbers"), and in addition hides small counts instead of rounding them.

- **Thresholds.** `DISCLOSURE_MIN_CELL = 5` for counts of people by sex, age group, governorate and status, the total, the service-record count and survey submissions. `DISCLOSURE_MIN_CELL_SENSITIVE = 10` for people per vulnerability tag and per service type (disability, displacement, psychosocial or protection services are special-category data). The function refuses a minimum below 5. No humanitarian source sets one cell size: the OCHA Centre's guidance is risk-based and says the acceptable risk is lower in conflict settings; official statistics use 3 to 11. Every count is a one-way table of one population.
- **Method.** Every count is computed exactly first. Then:
  1. Free-text tables (governorate, tags, service types): rows of 1 to minCell − 1 merge into one `__other__` row, so a small row never shows its label (a village or a name typed into the field). The governorate table also puts every unlisted place into `__other__` (§8.3). The "not recorded" row is kept.
  2. Counts of 1 to minCell − 1 are hidden (`count: null, suppressed: true`). 0 is shown as 0.
  3. Every other count, and every total, is rounded to the nearest 5 on its own (HESA's rounding), so the parts of a table may not add up to its total.
  4. Vulnerability tags and service types: a count is also hidden when 0 < total − count < 10, because then almost everyone in the project shares the attribute and the few who do not would stand out.
  5. Check. A reader can bound every published figure: a shown 10 is 8 to 12, a shown 5 is 5 to 7, a hidden count 1 to 4, and the sex, age group, governorate and status tables each add up to the total. When these bounds leave a single possible value for a hidden count (every figure at the edge of its rounding range: for example 8, 8 and 1, shown as 10, 10 and hidden, with a total of 17 shown as 15), that table is hidden whole: every key hidden, zeros included, and a free-text table shows no rows at all (each label would be a lower bound). When the table had nothing left to hide, nothing is shown (`suppressedAll`, as for a project of 1 to 4 beneficiaries). Tags and services are checked the same way against the bounds on the total.
  6. A project with 1 to 4 beneficiaries gets no figures at all (`suppressedAll`): zeros would reveal "all of them are …". Rows of free-text tables are ordered by the shown counts only.
- **What it guarantees.** The method is public. `tests/disclosure.test.ts` checks, by exhaustive search over small tables and linked pairs of tables, that a reader who knows the method cannot work out any hidden count exactly, and checks random four-table summaries with an independent bounds calculation.
- **Residual risks.** A reader can still narrow a hidden count to a few values (for example 1 or 2), and when a table is hidden whole, a reader who knows the method may learn that some category was small without learning which. Differencing over time (counts before and after one registration) is reduced but not removed by rounding for the beneficiary summary, which shows the current register; survey aggregates are not exposed to it, because a published month never changes (§8.3). There are no cross-tabulations: a sex × age table would need its own protection, otherwise a hidden marginal can be recovered from inner cells; sex- and age-disaggregated results for donor reports come from indicator breakdowns, which are not protected (§8.6).

### 8.5 Audit

`src/middleware/audit.ts` writes one `AuditLog` row per POST, PATCH, PUT or DELETE by a signed-in user, when the response finishes: `action` = method and path (no query string), `entity` = the first path segment after `/api`, `entityId` = the route's `:id` or the first UUID in the path, and `newValue = { status, fields }` (plus `aborted: true` when the client disconnected first). `fields` lists the names of the top-level fields the request body sent, sorted (for example `["targetValue"]` for a change of an indicator's target), never their values; only names that look like API field names are kept, at most 50. Refused requests (403) are therefore told apart from successes (OWASP A01). Successful writes to M&E records that hold no personal data also keep `values`: the allow-listed fields of the saved record the route answered with (`AUDIT_VALUE_ROUTES`), for project create and edit (name, status, sector, donor, budget, dates, target beneficiaries), framework create and approval, result create and edit (code, level, text, parent), indicator create, edit and approval (text, level, unit, status, baseline, target and current values with their dates, method and justification, intermediate targets), KPI suggestion acceptance (the same values of the indicator it creates, read from the response's `indicator`, plus the id of an indicator it replaced and the names of the fields the officer edited, `AUDIT_NESTED_VALUES`), data point entry (indicator, value, date, method; never notes, area, attachments or source text), and report publishing and unpublishing (report id, project, type, new status, generation date and period; never the title, narrative or file location). So the history of a baseline, target or current value, and of which reports were shared with donors or taken back, can be read back: who, when and to what. **No other value from a request or response body is stored**: beneficiary, service, qualitative, document, user, organisation and webhook-token writes keep field names only, because their bodies held beneficiaries' phone and ID numbers and new webhook tokens. `tests/audit.test.ts` checks that every allow-listed key is a staff route and that no free-text or personal field is listed. Uploads are now audited (the old code failed on the BigInt file size). Sign-in, webhooks and requests without a valid token are not attributed and not written. Owner decision D2: the live database was checked read-only on 13 October 2026 and holds no AuditLog, WebhookToken or Beneficiary rows, so there is nothing to clean or rotate.

### 8.6 Known limitations

1. Reset links are not single-use, and reset tokens share the access-token secret (they are refused as access tokens, §5). Follow-ups: single-use reset links; a separate audience or secret for reset tokens (RFC 8725 §3.12).
2. The audit log keeps the new values of allow-listed M&E fields (§8.5), not the previous ones; the previous value is the one in the row before. Audit entries for personal-data exports and downloads are F3.
3. KoboToolbox GPS is stored exactly; coarsening at ingestion needs an owner decision (F4).
4. Donor viewers see every project of their organisation, with budgets; per-donor project access needs a migration (F5).
5. Users are hard-deleted, together with their own notifications (so a donor viewer told about a published report can still be removed). A user who uploaded documents, entered data points or created a webhook token cannot be deleted (400). A removed user's refresh token is refused at once, but an access token already issued is not checked against the database and stays valid until it expires (15 minutes). Only a platform_admin should change a platform_admin (F6).
6. Donors still see assessment price estimates (`GET /assessments/:id/estimate`) (F7). Indicators the AI generated or suggested reach them only once an org admin approves them (Phase 4). Assessments have no review step, so the AI assessment report is not shown to donors at all; reports reach donors only once an org admin publishes them (§8.3).
7. Indicator values and the breakdowns staff enter are shown to donors exactly. Suppressing and rounding staff-entered breakdowns, and a protected sex × age table, are F8 (owner decision: donors' reporting templates often need exact disaggregated results).
8. Respondent-level rows are recognised by their source (`dataSource: KoboToolbox`, which the webhook writes). Results staff enter are trusted to be results: a row typed or imported per household under another source would reach donors as a value (without notes, author or unlisted area). An explicit "respondent-level" flag set at ingestion needs a migration (F13).
9. An approved anonymised donor summary per qualitative entry, and consent fields, are F9.
10. The disclosure thresholds are platform constants; a per-organisation raise (never lower) needs a column (F10, D4).
11. Document uploads have no AI rate limit for staff; `/export/beneficiaries` swallows database errors (F11).
12. Frontend: settings, new project and framework controls are hidden by role only after Phase 4 (F12); the server refuses them already.
13. Survey aggregates are published per month from the submissions received within 14 days of the month's end; later submissions (for example a backlog synced or resent weeks later) never reach donors as figures. Staff enter the survey round's result as an indicator value instead, which is the usual practice. A data point delete or edit route would change a published month; none exists, and adding one needs the same review.
14. Publishing has no separate review record: the audit log is the record of who published or took back a report, and when (§8.5). A published report reaches every donor viewer of the organisation (F5). A donor viewer's notification of a report that is later taken back to draft stays in their list, with the report title and project name only, until the viewer's account is deleted (item 5).

### 8.7 Sources

- OCHA, Information Sharing Protocol – Occupied Palestinian Territory (HCT-endorsed, 25 April 2025): https://www.unocha.org/attachments/f4e4af83-e999-4f6a-8443-6ccfe5986b5c/HCT-Endorsed-OPT-Information-Sharing-Protocol.pdf
- IASC Operational Guidance on Data Responsibility in Humanitarian Action (2023): https://cms.emergency.unhcr.org/sites/default/files/2023-11/IASC%20Operational%20Guidance%20on%20Data%20Responsibility%20in%20Humanitarian%20Action%2C%202023.pdf
- OCHA Centre for Humanitarian Data, Guidance Note #7: Responsible Data Sharing with Donors (2020): https://data.humdata.org/dataset/2048a947-5714-4220-905b-e662cbcd14c8/resource/5bfa1f7f-713c-4331-89d6-436f86f014d0/download/guidance-note-7.pdf
- OCHA Centre for Humanitarian Data, Guidance Note: Statistical Disclosure Control (2019): https://centre.humdata.org/wp-content/uploads/2019/07/guidance_note_sdc.pdf
- OCHA Data Responsibility Guidelines (revised 2025): https://data.humdata.org/dataset/2048a947-5714-4220-905b-e662cbcd14c8/resource/8bc5b848-8ece-4f1f-a78b-18dd972bb21a/download/data-responsibility-guidelines-2025.pdf
- ICRC, Handbook on Data Protection in Humanitarian Action, 3rd ed. (2024): https://alnap.hacdn.io/media/documents/Handbook_on_Data_Protection_in_Humanitarian_Action.pdf
- ICRC, Professional Standards for Protection Work, 3rd ed. (2018): https://blogs.icrc.org/new-delhi/wp-content/uploads/sites/93/2018/05/0999_002_Protection_UPD_04_2018_WEB.pdf
- UNEG Ethical Guidelines for Evaluation (2020): https://www.unevaluation.org/sites/default/files/file_uploads/2020EthicalGuidelinesforEvaluation_2866_11603124552541.pdf
- Core Humanitarian Standard (2024), Commitment 4: https://handbook.hspstandards.org/en/chs/2024/
- EU Humanitarian Aid Model Grant Agreement v2.0 (2025): https://www.dgecho-partners-helpdesk.eu/download/referencedocumentfile/334
- European Commission Guidance Note on humanitarian aid and EU restrictive measures (2022): https://commission.europa.eu/system/files/2022-06/220630-humanitarian-aid-guidance-note_en.pdf
- UNHCR General Policy on Personal Data Protection and Privacy (2022): https://www.refworld.org/sites/default/files/legacy-pdf/en/2022-12/63d3bdf94.pdf
- GBVIMS Sample GBV Information Sharing Protocol (Annex F): http://gbvims.com/wp/wp-content/uploads/Annex-F-GBV-Information-Sharing-Protocol-Template.pdf
- GDPR Article 25: https://gdpr-info.eu/art-25-gdpr/
- Jordan Personal Data Protection Law No. 24 of 2023: https://www.modee.gov.jo/ebv4.0/root_storage/en/eb_list_page/pdpl.pdf
- NHS England Digital, HES/ECDS disclosure control: https://digital.nhs.uk/data-and-information/data-tools-and-services/data-services/hospital-episode-statistics/disclosure-control-methodology-for-hospital-episode-statistics-and-emergency-care-data-set
- HESA, Rounding and suppression to anonymise statistics: https://www.hesa.ac.uk/about/regulation/data-protection/rounding-and-suppression-anonymise-statistics
- ResDAC, CMS Cell Size Suppression Policy: https://www.resdac.org/articles/cms-cell-size-suppression-policy
- FCSM/NCES Data Protection Toolkit, cell suppression: https://nces.ed.gov/fcsm/dpt/content/3-2-2-1
- OWASP Top 10:2021 A01 Broken Access Control: https://owasp.org/Top10/A01_2021-Broken_Access_Control/
- OWASP Authorization Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- RFC 8725, JSON Web Token Best Current Practices: https://www.rfc-editor.org/info/rfc8725/
- Palestine: 7amleh position paper on the draft data-protection decree-law: https://7amleh.org/post/position-paper-personal-data-protection-draft-law-by-decree-from-a-human-rights-based-perspective · WAFA, 4 November 2025: https://www.wafa.ps/Pages/Details/135228 (no comprehensive law in force; check again when it is issued)

No source gives one humanitarian cell size; the thresholds are a reasoned choice (§8.4).
