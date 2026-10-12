# Security setup

What changed in Phase 0 (and the AI rules added in Phase 3, §6) and what to do once per environment.

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
| `VOYAGE_API_KEY` | optional secret; embeddings for the indicator library. Without it nothing is sent to Voyage and search uses keywords |
| `VOYAGE_MODEL` | optional, default `voyage-4` |

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
- Rate limits: 300 requests/minute per IP overall; 30 per 15 minutes on `/api/auth/*`; 60 AI requests/hour per user; 120 webhook calls/minute per IP.
- Every route that takes an id checks the caller's organisation through `src/middleware/access.ts`; other organisations' records answer 404. Ids passed in a request body (indicator, assessment) must belong to the same project.
- Org admins can no longer grant the `platform_admin` role.
- The seed refuses to run in production and needs `SEED_PASSWORD` outside development.

## 6. AI providers and personal data (Phase 3)

Raqib sends text to Anthropic (all AI features) and, when `VOYAGE_API_KEY` is set, to Voyage AI (embeddings). Models receive aggregates and organisational text only (CLAUDE.md rule 5). Details per feature: `docs/AI.md` §9.

**Sent to Anthropic:** project metadata (name, sectors, donor, dates, target beneficiaries, geographic scope, the redacted description); redacted document text (at most 8 000 characters per document for frameworks, 12 000 for document analysis) and redacted file names; indicator texts, definitions, baselines, targets and aggregated values with areas and disaggregated counts; redacted qualitative entries (titles, content, themes); indicator library entries.

**Sent to Voyage:** indicator library text only (name, Arabic name, definition, tags); from Phase 4 also result statements. Never personal data.

**Never sent:** beneficiary records, user names and email addresses, passwords, tokens and keys, data point notes, original files.

**Personal data in documents.** Uploaded documents stay in the private bucket. The parser (`src/services/ai/documentParser.ts`) extracts the text and runs `redactPersonalData` (`src/services/ai/redact.ts`) before anything is stored or sent to a model. It removes email addresses (any script), phone numbers (+/00 international numbers, 970/972 mobiles and landlines, local 05X mobiles and 0[2489] landlines, in ASCII or Arabic digits, also inside PDF tables) and 9-digit ID numbers, replacing them with `[email removed]`, `[phone removed]` and `[ID number removed]`. `Document.parsedText` holds only redacted text. The model sees at most the first 12 000 characters plus the redacted file name. The analysis is stored in `Document.aiAnalysis`, never appended to `parsedText`. Qualitative entries are redacted the same way **when they are saved** (owner decision of 12 October 2026): the title, content, location and facilitator of typed notes, the typed title, location and facilitator of a transcript upload, and KoboToolbox qualitative submissions; `POST /api/projects/:id/qualitative` returns the counts as `redactions: { phone, idNumber, email }`, and the log line holds the entry id and the counts only. Qualitative entries, project descriptions, geographic scope, areas and data point text are redacted again before a prompt is built, and model output is redacted again before it is stored. FGD/KII transcripts uploaded through the qualitative upload are marked `qualitativeSource` and are used only for qualitative coding, never for document analysis, frameworks or assessments. **No API response returns `parsedText` or the storage key `fileUrl`**; document responses carry `textLength` instead.

**Limits.** Names and street addresses cannot be detected by patterns. The prompts forbid the model from writing them, but text that staff upload or type is sent as it is. **Staff must not put names, addresses or other identifying details of beneficiaries into documents, transcripts, notes or descriptions that Raqib analyses.** Documents parsed before Phase 3 keep unredacted text at rest until they are parsed again or the one-off backfill (owner decision of 12 October 2026) has run; until then the AI services redact it again before every model call, and the API never returns it. The backfill procedure, once per shared database after the Phase 3 SQL and the deploy (`docs/DATA_MODEL.md` §9, step "Run the backfill"):

1. Take a backup of the database (`pg_dump`; it contains personal data, so keep it private and delete it when no longer needed).
2. `npm run redact:backfill`: a dry run that prints totals (documents, and counts of phone numbers, ID numbers and email addresses) and writes nothing. It refuses when the Phase 3 SQL is missing.
3. `npm run redact:backfill -- --apply`: redacts `Document.parsedText` and the string values of `Document.aiAnalysis`. A row changed while the script runs is skipped and the summary asks to run it again; a second run changes nothing.

Existing qualitative entries are included with `--include-qualitative`; the owner approved this on 12 October 2026, so the shared database's run uses it. The script needs only `DATABASE_URL` and prints totals and row ids (`--verbose`), never text or file names. File names are kept as uploaded (downloads need them); a prompt that names a file gets the redacted name. Details: `docs/AI.md` §9.

**Logs.** Every AI call writes one `AiCall` row (feature, model, prompt versions, status, token counts, latency, estimated cost, organisation and project ids) and one console line with the same numbers. Neither ever holds prompt text, document text, model answers or error messages. AI job failures are logged with the AiError message or the error class name only (`safeErrorSummary`), never database error text. The parser logs document ids, lengths and redaction counts only; saving a qualitative entry logs its id and redaction counts only. `AiCall` rows are deleted after 24 months (`AI_CALL_RETENTION_MONTHS`) by a nightly worker job at 02:30 Asia/Hebron; `npm run ai-calls:prune` runs it by hand (dry run unless `-- --apply`).

**Anthropic API key.** `ANTHROPIC_API_KEY` is a secret like the JWT secrets: keep it in the environment, never in code, tests or logs. Tests point the SDK at an unreachable local address, so they can never call the real API; only `npm run ai:smoke` does.

## 7. Tests

```bash
# Unit tests run anywhere; integration tests need a disposable Postgres with pgvector
# whose database name contains "test" (all data in it is deleted).
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/raqib_test npx prisma db push --skip-generate
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/raqib_test npm test
```

`tests/isolation.test.ts` lists every route that takes an id and fails if a new one is added without an isolation check.
