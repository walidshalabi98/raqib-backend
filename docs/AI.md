# AI layer

How Raqib calls AI models (Phase 3). Rules that every AI feature follows are in `CLAUDE.md` (rules 4–7) and `knowledge/me-foundations.md`.

## 1. Where things are

| File | What it does |
|---|---|
| `src/services/ai/client.ts` | The only module that calls the Anthropic API: `generateStructured()` and `resolveModel()` |
| `src/services/ai/outputSchema.ts` | Builds the JSON schema sent for structured outputs from a zod schema |
| `src/services/ai/models.ts` | Model table: prices, effort support, refusal fallback support, cost estimate |
| `src/services/ai/errors.ts` | Typed errors (`AiRefusalError`, `AiOutputTruncatedError`, `AiInvalidOutputError`, `AiRequestError`) and `safeErrorSummary()` for logs |
| `src/services/ai/prompts/` | One versioned prompt file per feature, plus `system.ts` (the shared system prompt) |
| `src/services/ai/redact.ts` | Removes phone numbers, ID numbers and email addresses from text |
| `src/services/ai/embeddingProviders.ts` | Embedding providers (Voyage, or none) without the API environment, so `npm run seed:library` needs only `DATABASE_URL` |
| `src/services/ai/embeddings.ts` | Re-exports the providers and adds `getEmbeddingProvider(env)` for the app |
| `src/services/ai/indicatorFigures.ts` | Figures calculated in code (progress, trend) and `unverifiedFigures()`, the check for numbers in AI text |
| `src/services/ai/*.ts` (others) | The features: framework generator, document analysis, indicator alternatives, qualitative coding, report narrative, risk analysis, assessment report |
| `src/services/qualitative/redactEntry.ts` | Redacts a qualitative entry's title, content, location and facilitator when it is saved (§9) |
| `src/services/maintenance/aiCallRetention.ts` | AiCall retention: the cutoff, the batched delete, the nightly job and `npm run ai-calls:prune` (§7) |
| `src/services/maintenance/redactStoredText.ts` | The one-off backfill `npm run redact:backfill` for text stored before Phase 3 (§9) |

`tests/aiGuard.test.ts` and ESLint (`no-restricted-imports`, plus `no-restricted-syntax` for `import()` and `require()`) fail the build if code in `src/`, `scripts/` or `prisma/` imports an `@anthropic-ai` package outside `client.ts` and `models.ts` (`outputSchema.ts` may import only the JSON schema transform), names a model id (except the `AI_MODEL_MAIN` / `AI_MODEL_FAST` defaults in `env.ts` and the seed's sample-history constant), cleans JSON by hand, or loads the shared system prompt outside the client and startup.

## 2. The client contract

```ts
const result = await generateStructured({
  feature: 'report.narrative',      // stable id, stored on the AiCall row
  model: 'main',                    // tier: 'main' (AI_MODEL_MAIN) or 'fast' (AI_MODEL_FAST); never a model id
  system: NARRATIVE_SYSTEM,         // the feature's own instructions (optional)
  messages: [{ role: 'user', content: prompt }],
  schema: NARRATIVE_SCHEMA,         // zod/v4 schema of the answer
  maxTokens: 8000,
  promptVersion: NARRATIVE_PROMPT_VERSION,
  effort: 'medium',                 // 'low' | 'medium' | 'high'; default 'medium'
  timeoutMs: 180_000,               // optional; default AI_REQUEST_TIMEOUT_MS
  context: { organizationId, projectId },
});
// result: { data, model (served model), promptVersion, usage, estimatedCostUsd, aiCallId }
```

The client always sends the shared system prompt first, then `system`. It never sends `temperature`, `top_p`, `top_k` or a thinking setting. `effort` goes in `output_config.effort`, and only to models that accept it.

## 3. Structured outputs

- Each call sends `output_config.format = { type: 'json_schema', schema }`, built by `outputJsonSchema(schema)`. This is the SDK's `zodOutputFormat` transform (`additionalProperties: false` everywhere; unsupported keywords such as `minLength` moved into descriptions), except that `enum` and `const` stay in the schema so the API enforces them. The SDK transform would turn them into hints, and one off-list value would then fail a whole call.
- The client joins the text blocks, parses them as JSON and validates the result again with the same zod schema.
- Schema rules: the root is an object; every property is required; use `""` or `null` for unknown values; no transforms. `tests/aiSchemaHelpers.ts` (`structuredOutputSchemaProblems`) checks every feature schema against these rules.
- Invalid JSON or a schema mismatch throws `AiInvalidOutputError`. Its `issues` read "path: problem" and never quote the answer.

## 4. Retries, timeouts, `max_tokens` and refusals

| Situation | What the client does |
|---|---|
| 408, 409, 429, 5xx (including 529), network error | Retries up to `AI_MAX_RETRIES` times (default 3). Backoff 1 s, 2 s, 4 s… with jitter, at most 30 s; `retry-after-ms` / `retry-after` are honoured (also capped at 30 s). The SDK's own retries are off. |
| Timeout | `AI_REQUEST_TIMEOUT_MS` (default 60 s) or the call's `timeoutMs`, at most 3 600 000 ms (one hour); the doubled timeout after a cut-off answer is capped too. A timed-out request is retried at most once per call. |
| 400, 401, 403, 404, 413, 422 | No retry; throws `AiRequestError` with the status. |
| Retries used up | Throws `AiRequestError` with `retryable: true` and the number of attempts. |
| `stop_reason: "max_tokens"` | Retries once with double the token limit (at most 64 000) and double the timeout. Cut off again: `AiOutputTruncatedError`. |
| `stop_reason: "model_context_window_exceeded"` | No retry (more output tokens cannot help): `AiOutputTruncatedError` with `stopReason: "model_context_window_exceeded"`; the AiCall row has status `max_tokens` and that stop reason. |
| `stop_reason: "refusal"` | Throws `AiRefusalError` with the category (for example `cyber`). The content of a refused answer is never read. |
| The system prompt or the answer schema cannot be built | Nothing is sent; `AiRequestError` with 0 attempts and an AiCall row with status `error`. |

Requests are not streamed. The framework indicator call (32 000 tokens, 300 s) waits for the whole answer on one HTTP request; if a proxy cuts idle connections, switch `client.ts` to streaming (no service would change).

### Server-side refusal fallback

With `AI_REFUSAL_FALLBACK=default` (the default), calls to models that support it (Sonnet 5.5, Opus 5, Opus 5.5) use the beta endpoint with `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`. If the model declines in some categories, Anthropic re-runs the same request on a fallback model inside the same call: for Sonnet 5.5 only `cyber` and `frontier_llm` declines are retried (on Claude Sonnet 5); `bio`, `general_harms` and `reasoning_extraction` declines still throw `AiRefusalError` with their category. The model that answered is `to.model` of the last `fallback` content block when there is one, otherwise `response.model`; it is stored as `servedModel` on the AiCall row and returned as `result.model` (the framework generator stores it on the indicators and `Framework.aiModelUsed`).

Haiku 5.5 (the fast tier) has no server-side fallback: a refusal there throws `AiRefusalError`. To turn the fallback off everywhere, set `AI_REFUSAL_FALLBACK=off`; refusals then throw `AiRefusalError` on every model.

### What each feature does when the AI fails

| Feature | On an AI error |
|---|---|
| Framework: structure step | Invalid or cut-off answer: builds the results chain from project data. Refusal or request error: the job stops and the version is marked failed. |
| Framework: indicators step | Any error stops the job and nothing else is written. The version gets `Framework.generationError` (the AiError message or only the error class, never model output); `GET /api/frameworks/:id/status` then returns `{ status: 'failed', message }`. A failed version is never the project's current framework (the newest version with `generationError` null). An empty AI draft older than 45 minutes is reported as interrupted. |
| Document analysis | The document is still parsed (`completed`); `aiAnalysis` stays `null`. FGD/KII transcripts (`Document.qualitativeSource`) are never analysed. |
| Indicator alternatives, report narrative | The error goes to the caller; stored data is unchanged. |
| Qualitative coding | The entry is unchanged. |
| Risk analysis | Falls back to the deterministic assessment; an analysis that contains figures not found in the data is replaced by the deterministic text. |
| Assessment report | Any failure before or during the AI call leaves the assessment in `analysis` with a fixed message ("AI generation failed: …"), never the error text; there is no retry yet (Phase 6 adds a backend endpoint and a button, owner decision of 12 October 2026). A received answer is never discarded: the assessment, its Report and the notifications are written in one transaction; if that fails, the assessment alone is saved as delivered. The Report has type `assessment_report` for every assessment type, midterm included (midterms used to get `quarterly_summary`; existing reports keep their type). |

Logs use `safeErrorSummary()`: the AiError message, or only the class name for any other error (database errors can echo stored values).

## 5. Shared system prompt and prompt caching

`src/services/ai/prompts/system.ts` builds the shared system prompt: a role paragraph (`ROLE_PROMPT`: Palestine and regional M&E specialist, donor landscape with USAID as a legacy donor since 1 July 2025, structured output only, English and Modern Standard Arabic, never invent numbers, no personal data) followed by the title and sections 1–12 of `knowledge/me-foundations.md`. The introduction and §13 onwards are left out.

- The API and the worker build it at startup and stop with a clear message if the file or a section is missing.
- Its version is `system-v1-<10 hex>`, a hash of the text, so any edit to §1–12 changes it. The version is stored on every AiCall row as `systemPromptVersion`.
- The client sends it as the first system block with `cache_control: { type: "ephemeral" }`; the feature's instructions follow in a second block. Calls within 5 minutes on the same model read it from the cache (about 4 000 tokens at a tenth of the input price). Check `cacheReadTokens` on AiCall rows: a value above 0 on the second call in a row means caching works.

## 6. Features, prompt versions and settings

| Feature id | Prompt version | Prompt file | Tier | Effort | Max tokens | Timeout |
|---|---|---|---|---|---|---|
| `framework.structure` | `framework-v4` | `prompts/framework.ts` | main | medium | 12 000 | 180 s |
| `framework.indicators` | `framework-v4` | `prompts/framework.ts` | main | medium | 32 000 | 300 s |
| `document.analysis` | `document-analysis-v2` | `prompts/documentAnalysis.ts` | fast | low | 4 000 | default |
| `indicator.alternatives` | `alternatives-v2` | `prompts/alternatives.ts` | fast | low | 4 000 | default |
| `qualitative.coding` | `qualitative-coding-v2` | `prompts/qualitative.ts` | fast | low | 4 000 | default |
| `risk.analysis` | `risk-analysis-v2` | `prompts/risk.ts` | fast | low | 4 000 | default |
| `report.narrative` | `report-narrative-v3` | `prompts/narrative.ts` | main | medium | 8 000 | 180 s |
| `assessment.report` | `assessment-report-v3` | `prompts/assessment.ts` | main | medium | 16 000 | 300 s |
| (every call) | `system-v1-<hash>` | `prompts/system.ts` | | | | |

Change a prompt's version whenever you change its text or schema. Defaults: `AI_MODEL_MAIN=claude-sonnet-5-5`, `AI_MODEL_FAST=claude-haiku-5-5` (values are trimmed; a blank value uses the default), default timeout 60 s (`AI_REQUEST_TIMEOUT_MS`, 1 000–3 600 000 ms).

## 7. AiCall log and cost

Every `generateStructured` call writes exactly one `AiCall` row, whatever the outcome: feature, requested and served model, prompt version, system prompt version, status (`success`, `refusal`, `max_tokens`, `invalid_output`, `error`), stop reason, error class name, attempts, input/output/cache tokens summed over attempts, latency, estimated cost and the organisation and project ids. It never stores prompt text, document text, model answers, error messages or user ids. This includes calls where the shared system prompt or the answer schema cannot be built (status `error`, 0 attempts, nothing sent). If the project or organisation was deleted while the call ran, the row is written again without the project (or without both), so the cost is kept. If the row still cannot be written, the call succeeds (`aiCallId: null`) and a warning names the error class. One `[ai] …` console line per call carries the same numbers.

**Retention.** AiCall rows are kept for `AI_CALL_RETENTION_MONTHS` calendar months (default 24, owner decision of 12 October 2026; allowed 1–120) and then deleted. The cutoff is counted in UTC, with the day clamped to the end of a shorter month (29 February 2028 minus 24 months is 28 February 2026). The worker registers the job scheduler `prune-ai-calls` on the `maintenance` queue (cron `30 3 * * *`, Asia/Hebron, so every night at 03:30, an hour that exists exactly once even on the nights the clocks change) and deletes older rows oldest first in batches of 5 000, so locks stay short; it logs one line with numbers only. `npm run ai-calls:prune` shows the cutoff and how many rows are older (dry run); `npm run ai-calls:prune -- --apply` deletes them. It needs only `DATABASE_URL` (and `AI_CALL_RETENTION_MONTHS` when not the default). Retention only runs while the worker runs; without a worker, run the script by hand.

The estimate uses the prices in `src/services/ai/models.ts` (USD per million tokens, Anthropic API, October 2026):

| Model | Input | Output | Cache write | Cache read |
|---|---|---|---|---|
| `claude-sonnet-5-5` | 2.00 | 10.00 | 2.50 | 0.20 |
| `claude-haiku-5-5` (prompt ≤ 100K tokens) | 0.10 | 0.50 | 0.125 | 0.01 |
| `claude-haiku-5-5` (prompt > 100K tokens) | 0.50 | 2.50 | 0.625 | 0.05 |
| `claude-opus-5-5` | 4.00 | 20.00 | 5.00 | 0.20 |
| `claude-opus-5` | 5.00 | 25.00 | 6.25 | 0.50 |
| `claude-opus-4-8` (fallback target for Opus) | 5.00 | 25.00 | 6.25 | 0.50 |
| `claude-sonnet-5` (fallback target for Sonnet 5.5) | 2.00 | 10.00 | 2.50 | 0.20 |

An unknown model id gets no effort, no fallback and no price: its tokens are counted but left out of the estimate, with a `[ai] <feature>: no price for model <id>` warning; the cost is `null` only when nothing in the call could be priced. After a server-side fallback the client reads `usage.iterations` (one entry per attempt; the top-level usage covers only the attempt that answered) and prices each attempt at its own model. Cost per organisation for the last 30 days:

```sql
SELECT "organizationId", feature, count(*), sum("estimatedCostUsd") AS usd
FROM "AiCall" WHERE "createdAt" > now() - interval '30 days'
GROUP BY 1, 2 ORDER BY usd DESC NULLS LAST;
```

Totals per organisation cover at most the retention period. `AiCall` has row level security on and no API route reads it yet. More queries are in `docs/DATA_MODEL.md` §7.

## 8. Embeddings

`src/services/ai/embeddingProviders.ts` defines `EmbeddingProvider` with two implementations:

- **Voyage** (`VOYAGE_API_KEY` set): `voyage-4` by default (`VOYAGE_MODEL`), 1024 dimensions, up to 128 texts per request, 60 s timeout, 3 retries on 408/429/5xx and network errors.
- **None** (no key): nothing is embedded and search uses keywords.

`npm run seed:library` needs only `DATABASE_URL` (plus `VOYAGE_API_KEY` and `VOYAGE_MODEL` to embed). It embeds every library entry whose vector is missing or was made by another model (`IndicatorLibraryEntry.embeddingModel`; input type `document`; text = name, Arabic name, definition, tags), so a model change or a failed run is repaired by the next plain run; `-- --reembed` forces every entry. A second run embeds nothing. Changing an entry's name, Arabic name, definition or tags clears its vector. Vectors are cast to the column's resolved type (`libraryVectorType`), never a bare `::vector`, because on Supabase pgvector lives in the `extensions` schema. Only indicator library text is sent to Voyage (from Phase 4 also result statements), never personal data.

## 9. Privacy and redaction

Rule: models receive aggregates and organisational text, never beneficiary-level personal data (`CLAUDE.md` rule 5, `me-foundations.md` §12).

What is sent to Anthropic, by feature:

- **Framework:** project name, sectors, donor, dates and target beneficiaries; the redacted project description and geographic scope; up to 8 000 characters of each parsed document, redacted, except FGD/KII transcripts (`Document.qualitativeSource`), which framework generation never uses; matching indicator library entries.
- **Document analysis:** the first 12 000 characters of the redacted document text and the redacted file name.
- **Indicator alternatives:** the indicator's text, definition, unit and result; donor guidance; the redacted project description.
- **Qualitative coding:** the entry's title and content (transcripts, notes), redacted.
- **Report narrative and risk analysis:** indicator names, baselines, targets, aggregated values, redacted areas and value text, and disaggregated counts written per dimension (`sex: female 9120, male 8790`; whole dimensions only, then `(further categories omitted)`, never a cut number), plus progress figures calculated in code. Data point notes are not sent.
- **Assessment report:** the above, plus redacted titles, themes, locations and excerpts (at most 500 characters) of qualitative entries with their participant counts, and redacted document summaries (transcripts excluded).

Never sent: beneficiary records, user names and email addresses, passwords and tokens, data point notes, file contents beyond the limits above.

**Redaction** (`redactPersonalData` in `redact.ts`, pure and tested in English and Arabic) removes, in ASCII, Arabic-Indic and Extended Arabic-Indic digits:

- email addresses in any script, punycode (`xn--`) domains, fullwidth `＠`/`．` and apostrophes in the local part → `[email removed]`;
- phone numbers (+/00 international numbers, 970/972 mobiles and landlines with or without the prefix, local 05X mobiles also written in pairs, 0[2489] landlines), with a dash, dot, one or two spaces or tabs, one line break, parentheses or invisible characters between the digits, also when a Latin word or a slash is written against them → `[phone removed]`;
- 9-digit ID numbers, also after a label and a slash (`ID/401234567`, `هوية/401234567`) or next to another ID; a 9-digit run joined to a code (`ENI/2026/412345678`) is kept → `[ID number removed]`.

Redaction runs in linear time, so long lists of numbers cannot slow the server. PDF text is extracted with a tab between the cells of a table row, so numbers in tables are found too.

It runs on parsed documents before anything is stored (`Document.parsedText` holds only redacted text), on qualitative entries when they are saved (owner decision of 12 October 2026, `src/services/qualitative/redactEntry.ts`: the title, content, location and facilitator of typed notes, the typed title, location and facilitator of a transcript upload, and KoboToolbox qualitative submissions), on qualitative entries and project descriptions again before a prompt is built, and again on model output before it is stored (narrative, assessment, themes, document analysis). `POST /api/projects/:id/qualitative` answers with the saved entry plus `redactions: { phone, idNumber, email }` (counts only), and refuses a title, content, location or facilitator that is not text (400); the upload refuses a repeated title, location or facilitator field. The frontend shows a hint under the notes and upload fields and, when something was removed, a message without the counts. Log lines carry the entry id and the counts, never the text. Entries saved before this change are only redacted by the backfill below with `--include-qualitative`.

**Limits.** Names and street addresses cannot be removed reliably by patterns. The prompts forbid the model from writing them, but whatever text staff upload or type is sent as it is. Staff must not paste names, addresses or other identifying details of beneficiaries into documents, transcripts, notes or descriptions that Raqib analyses. Other known trade-offs: a 9-digit amount written without separators or a currency is removed as an ID number; ID numbers written in groups (`401 234 567`) are kept. Documents parsed before Phase 3 keep their unredacted `parsedText` at rest until they are parsed again or the backfill below is applied; the AI services redact it again before every model call, and no API response returns `parsedText` or `fileUrl` (document responses carry `textLength` instead). File names (`Document.fileName`, the `fileName` of qualitative attachments) are kept as uploaded, because downloads use them; a prompt that names a file gets the redacted name.

**Backfill of stored text** (owner decision of 12 October 2026; `scripts/redact-stored-text.ts`, logic in `src/services/maintenance/redactStoredText.ts`). It runs `redactPersonalData` over text stored before Phase 3: `Document.parsedText`, and every string value in `Document.aiAnalysis` (keys, numbers, booleans and null stay exactly as stored, so a figure kept as a JSON number is not changed). Run it once on each shared database, after the Phase 3 SQL and the deploy, with a fresh backup (`docs/DATA_MODEL.md` §9, step "Run the backfill"):

```bash
npm run redact:backfill                               # dry run: totals only, nothing is written
npm run redact:backfill -- --apply                    # writes the changes; take a backup first
npm run redact:backfill -- --include-qualitative      # also existing qualitative entries (title, content, location, facilitator)
npm run redact:backfill -- --verbose                  # also the ids of the rows that change
```

- It needs only `DATABASE_URL`, and refuses (exit 1, nothing changed) when `Document.aiAnalysis` is missing: apply `prisma/sql/2026-10-12_phase3_ai_foundation.sql` first.
- Rows are read in id order, 100 at a time. A row is written only if it still holds what was read; a row edited or parsed again meanwhile is skipped and the summary asks to run the script again. Rows with nothing to remove are never written, and a second `--apply` changes nothing.
- It prints totals and, with `--verbose`, row ids; never text or file names.
- `--include-qualitative` is off by default; the owner approved it for the shared database on 12 October 2026, so that run uses it. Entries saved since the October 2026 change are already redacted.
- A `parsedText` that still holds a legacy `---AI_ANALYSIS---` analysis (written by the old API after the Phase 3 SQL ran) is redacted as plain text. If that analysis has a bare 9-digit JSON number, it becomes `[ID number removed]` and the analysis no longer parses, so readers fall back to the document text; the dry run counts these documents.

**Checks on numbers in AI text** (`me-foundations.md` §6). Document analysis marks each `targetsMentioned` item `verified` only when the target is found in the redacted document text, and lists other figures it could not find in `unverifiedFigures`. Report narratives, assessments and risk analyses are checked with `unverifiedFigures(text, allowed)`: figures not among those sent to the model are shown as "Check these figures: … — not found in the data provided" in the report and assessment HTML, and a risk analysis that contains them is replaced by the deterministic text. Framework baselines, targets and intermediate targets marked as from a document must equal a figure the structure step extracted with the same kind and a quote found word for word in the document.

## 10. Smoke test with the real API

Tests always mock the client. To check one real framework generation end to end:

```bash
npm run ai:smoke -- --yes                       # the dev seed project "Gaza Emergency WASH and Cash Response"
npm run ai:smoke -- --yes --project <projectId> # a project with an uploaded proposal (also runs the structure step)
```

**It costs money** (one or two main-tier calls, usually well under 1 USD) and needs a real `ANTHROPIC_API_KEY` and a development database. It refuses when `NODE_ENV=production`, with a placeholder key, without `--yes`, or unless `DATABASE_URL` points at localhost or a database whose name contains `dev` or `test` (pass `--i-know-this-is-not-shared` for a Supabase development branch). It adds a new framework version and never deletes it; a failed run leaves that version marked failed. It prints the indicators per level, the reference-sheet fields still to be confirmed for each (including the markers "Baseline date: to be confirmed." and "Intermediate targets: to be confirmed after the baseline."), and the run's AiCall rows (tokens, cache reads, cost); never prompts, document text or raw answers. The dev seed project has no uploaded document, so a run on it only exercises the indicator call.

## 11. Adding an AI feature

1. Write `src/services/ai/prompts/<feature>.ts` with a `*_PROMPT_VERSION`, a zod/v4 root-object schema (every property required) and the feature's system text.
2. Call `generateStructured` with a tier, an effort, a token limit and `context: { organizationId, projectId }`.
3. Redact free text before building the prompt; send aggregates only.
4. Check the answer in code (numbers against documents or standards, ids against the input), and redact text before storing it.
5. Test with the client mocked: success, invalid output, truncation, refusal and request errors; and add the schema to a `structuredOutputSchemaProblems` test.
