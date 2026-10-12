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
| `src/services/ai/embeddings.ts` | Embedding providers (Voyage, or none) |
| `src/services/ai/*.ts` (others) | The features: framework generator, document analysis, indicator alternatives, qualitative coding, report narrative, risk analysis, assessment report |

`tests/aiGuard.test.ts` and an ESLint rule fail the build if a service imports the SDK, names a model id, cleans JSON by hand or sends its own copy of the system prompt.

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
| Timeout | `AI_REQUEST_TIMEOUT_MS` (default 60 s) or the call's `timeoutMs`. A timed-out request is retried at most once per call. |
| 400, 401, 403, 404, 413, 422 | No retry; throws `AiRequestError` with the status. |
| Retries used up | Throws `AiRequestError` with `retryable: true` and the number of attempts. |
| `stop_reason: "max_tokens"` | Retries once with double the token limit (at most 64 000) and double the timeout. Cut off again: `AiOutputTruncatedError`. |
| `stop_reason: "refusal"` | Throws `AiRefusalError` with the category (for example `cyber`). The content of a refused answer is never read. |

Requests are not streamed. The framework indicator call (32 000 tokens, 300 s) waits for the whole answer on one HTTP request; if a proxy cuts idle connections, switch `client.ts` to streaming (no service would change).

### Server-side refusal fallback

With `AI_REFUSAL_FALLBACK=default` (the default), calls to models that support it (Sonnet 5.5, Opus 5, Opus 5.5) use the beta endpoint with `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`. If the model declines, Anthropic re-runs the same request on its default fallback model inside the same call. The model that answered is read from `response.model`, stored as `servedModel` on the AiCall row and returned as `result.model` (the framework generator stores it on the indicators and `Framework.aiModelUsed`).

Haiku 5.5 (the fast tier) has no server-side fallback: a refusal there throws `AiRefusalError`. To turn the fallback off everywhere, set `AI_REFUSAL_FALLBACK=off`; refusals then throw `AiRefusalError` on every model.

### What each feature does when the AI fails

| Feature | On an AI error |
|---|---|
| Framework: structure step | Invalid or cut-off answer: builds the results chain from project data. Refusal or request error: the job stops. |
| Framework: indicators step | Any error stops the job; nothing is written (the version stays an empty draft). |
| Document analysis | The document is still parsed (`completed`); `aiAnalysis` stays `null`. |
| Indicator alternatives, report narrative | The error goes to the caller; stored data is unchanged. |
| Qualitative coding | The entry is unchanged. |
| Risk analysis | Falls back to the deterministic assessment. |
| Assessment report | The assessment stays in `analysis` with a fixed message ("AI generation failed: …"), never the error text. |

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
| `report.narrative` | `report-narrative-v2` | `prompts/narrative.ts` | main | medium | 8 000 | 180 s |
| `assessment.report` | `assessment-report-v2` | `prompts/assessment.ts` | main | medium | 16 000 | 300 s |
| (every call) | `system-v1-<hash>` | `prompts/system.ts` | | | | |

Change a prompt's version whenever you change its text or schema. Defaults: `AI_MODEL_MAIN=claude-sonnet-5-5`, `AI_MODEL_FAST=claude-haiku-5-5`, default timeout 60 s.

## 7. AiCall log and cost

Every `generateStructured` call writes exactly one `AiCall` row, whatever the outcome: feature, requested and served model, prompt version, system prompt version, status (`success`, `refusal`, `max_tokens`, `invalid_output`, `error`), stop reason, error class name, attempts, input/output/cache tokens summed over attempts, latency, estimated cost and the organisation and project ids. It never stores prompt text, document text, model answers, error messages or user ids. If the row cannot be written, the call still succeeds (`aiCallId: null`) and a warning names the error class. One `[ai] …` console line per call carries the same numbers.

The estimate uses the prices in `src/services/ai/models.ts` (USD per million tokens, Anthropic API, October 2026):

| Model | Input | Output | Cache write | Cache read |
|---|---|---|---|---|
| `claude-sonnet-5-5` | 2.00 | 10.00 | 2.50 | 0.20 |
| `claude-haiku-5-5` (prompt ≤ 100K tokens) | 0.10 | 0.50 | 0.125 | 0.01 |
| `claude-haiku-5-5` (prompt > 100K tokens) | 0.50 | 2.50 | 0.625 | 0.05 |
| `claude-opus-5-5` | 4.00 | 20.00 | 5.00 | 0.20 |

An unknown model id gets a `null` cost, no effort and no fallback. After a server-side fallback, all tokens are priced at the served model's rates, so the estimate can be slightly off. Cost per organisation for the last 30 days:

```sql
SELECT "organizationId", feature, count(*), sum("estimatedCostUsd") AS usd
FROM "AiCall" WHERE "createdAt" > now() - interval '30 days'
GROUP BY 1, 2 ORDER BY usd DESC NULLS LAST;
```

`AiCall` has row level security on and no API route reads it yet. More queries are in `docs/DATA_MODEL.md` §7.

## 8. Embeddings

`src/services/ai/embeddings.ts` defines `EmbeddingProvider` with two implementations:

- **Voyage** (`VOYAGE_API_KEY` set): `voyage-4` by default (`VOYAGE_MODEL`), 1024 dimensions, up to 128 texts per request, 60 s timeout, 3 retries on 408/429/5xx and network errors.
- **None** (no key): nothing is embedded and search uses keywords.

`npm run seed:library` embeds every library entry that has no embedding (input type `document`; text = name, Arabic name, definition, tags). A second run embeds nothing. Changing an entry's name, Arabic name, definition or tags clears its vector, and the next run with a key embeds it again. After changing `VOYAGE_MODEL`, run `npm run seed:library -- --reembed`: vectors from different models cannot be compared. Only indicator library text is sent to Voyage (from Phase 4 also result statements), never personal data.

## 9. Privacy and redaction

Rule: models receive aggregates and organisational text, never beneficiary-level personal data (`CLAUDE.md` rule 5, `me-foundations.md` §12).

What is sent to Anthropic, by feature:

- **Framework:** project name, sectors, donor, dates, target beneficiaries and geographic scope; the project description and up to 8 000 characters of each parsed document, both redacted; matching indicator library entries.
- **Document analysis:** the first 12 000 characters of the redacted document text and the redacted file name.
- **Indicator alternatives:** the indicator's text, definition, unit and result; donor guidance; the redacted project description.
- **Qualitative coding:** the entry's title and content (transcripts, notes), redacted.
- **Report narrative and risk analysis:** indicator names, baselines, targets, aggregated values, areas and disaggregated counts, and progress figures calculated in code. Data point notes are not sent.
- **Assessment report:** the above, plus redacted titles, themes and excerpts (at most 500 characters) of qualitative entries with their participant counts and locations, and redacted document summaries.

Never sent: beneficiary records, user names and email addresses, passwords and tokens, data point notes, file contents beyond the limits above.

**Redaction** (`redactPersonalData` in `redact.ts`, pure and tested in English and Arabic) removes, in ASCII, Arabic-Indic and Extended Arabic-Indic digits:

- email addresses → `[email removed]`;
- phone numbers (+/00 international numbers, 970/972 mobiles, local 05X mobiles, 0[2489] landlines) → `[phone removed]`;
- 9-digit ID numbers → `[ID number removed]`.

It runs on parsed documents before anything is stored (`Document.parsedText` holds only redacted text), on qualitative entries and project descriptions before a prompt is built, and again on model output before it is stored (narrative, assessment, themes, document analysis).

**Limits.** Names and street addresses cannot be removed reliably by patterns. The prompts forbid the model from writing them, but whatever text staff upload or type is sent as it is. Staff must not paste names, addresses or other identifying details of beneficiaries into documents, transcripts, notes or descriptions that Raqib analyses. Other known trade-offs: a 9-digit amount written without separators or a currency is removed as an ID number; ID numbers written in groups (`401 234 567`) are kept. Documents parsed before Phase 3 keep their unredacted `parsedText` at rest until they are parsed again; the AI services redact it again before every model call.

## 10. Smoke test with the real API

Tests always mock the client. To check one real framework generation end to end:

```bash
npm run ai:smoke -- --yes                       # the dev seed project "Gaza Emergency WASH and Cash Response"
npm run ai:smoke -- --yes --project <projectId> # a project with an uploaded proposal (also runs the structure step)
```

**It costs money** (one or two main-tier calls, usually well under 1 USD) and needs a real `ANTHROPIC_API_KEY` and a development database. It refuses when `NODE_ENV=production`, with a placeholder key, or without `--yes`. It adds a new framework version and never deletes it. It prints the indicators per level, the reference-sheet fields still to be confirmed for each, and the run's AiCall rows (tokens, cache reads, cost); never prompts, document text or raw answers. The dev seed project has no uploaded document, so a run on it only exercises the indicator call.

## 11. Adding an AI feature

1. Write `src/services/ai/prompts/<feature>.ts` with a `*_PROMPT_VERSION`, a zod/v4 root-object schema (every property required) and the feature's system text.
2. Call `generateStructured` with a tier, an effort, a token limit and `context: { organizationId, projectId }`.
3. Redact free text before building the prompt; send aggregates only.
4. Check the answer in code (numbers against documents or standards, ids against the input), and redact text before storing it.
5. Test with the client mocked: success, invalid output, truncation, refusal and request errors; and add the schema to a `structuredOutputSchemaProblems` test.
