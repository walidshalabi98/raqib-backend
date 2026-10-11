# KPI Assistant and Active Monitoring — Specification

Version 1.0 · October 2026

This document specifies two AI features. Build them in the order given in `docs/BUILD_GUIDE.md` (Phases 4 and 5).

1. **KPI Assistant** — suggests indicators (KPIs) that fit the project being monitored, explains why, and lets the user accept, edit or reject each one.
2. **Active Monitoring** — watches every active project, raises insights when something needs attention (missing baselines, overdue data, off-track indicators, framework gaps), and proposes next actions.

Read `knowledge/me-foundations.md` first. Every rule in it applies here.

---

## Part A — KPI Assistant

### A1. User stories

- As an M&E officer setting up a project, I click **Suggest KPIs** and get a short, ranked list of indicators for each outcome and output, with the reason each one fits.
- As an M&E officer, I can ask for suggestions for one result only (e.g., "Outcome 2") without regenerating the whole framework.
- As an M&E officer, I accept a suggestion in one click; it becomes an indicator in my framework with all reference-sheet fields filled and its source recorded.
- As an M&E officer, I can edit a suggestion before accepting, or reject it with a reason so the system learns what my organisation does not want.
- As an org admin, I can see which indicators came from the library, which were AI-written, and which are donor-standard.
- As a donor viewer, I see only approved indicators, never raw suggestions.

### A2. Triggers

| Trigger | Scope | Who |
|---|---|---|
| "Suggest KPIs" button on the framework page | Whole framework or a selected result | me_officer, org_admin |
| New outcome/output added to the results chain | That result | Automatic, shown as a non-blocking prompt ("3 suggested indicators for this output") |
| Indicator rejected or marked weak by the quality check | Alternatives for that indicator | Automatic prompt |
| Framework generation (existing AI Wizard) | Whole framework | Replaces the current single-shot prompt in `frameworkGenerator.ts` |

### A3. Inputs (the "project context" object)

Built server-side by `buildProjectContext(projectId, scope)`. Never include beneficiary-level personal data.

```ts
type ProjectContext = {
  project: {
    id: string; name: string; sectors: Sector[]; donor: string; donorType: DonorType;
    startDate: string; endDate: string; geographicScope: string | null;
    targetBeneficiaries: number | null; humanitarian: boolean; description: string | null;
  };
  resultsChain: Array<{ id: string; level: 'impact' | 'outcome' | 'output'; text: string; parentId: string | null }>;
  scope: { type: 'framework' } | { type: 'result'; resultId: string } | { type: 'alternatives'; indicatorId: string };
  existingIndicators: Array<{ id: string; resultId: string | null; name: string; level: string; unit: string | null }>;
  documentFacts: Array<{ documentId: string; fileName: string; excerpt: string }>; // targets/baselines found in uploaded docs, ≤ 40 excerpts
  orgPreferences: { rejectedLibraryIds: string[]; preferredMethods: string[] }; // from feedback history
  donorRules: { maxIndicatorsPerResult: number | null; requiredFrameworks: string[]; notes: string[] };
};
```

`donorRules` comes from a small config file (`src/services/ai/donorRules.ts`):

| donorType | requiredFrameworks | maxIndicatorsPerResult | notes |
|---|---|---|---|
| eu | GERF Level 2, GAP III | none | Use GERF Level 2 first; sex/gender disaggregation mandatory for people counts |
| echo | ECHO KRIs | 3 (4 with one justified custom) | Baseline compulsory; specific sources only |
| undp, unicef, wfp, unfpa | Agency strategic plan, SDG | none | Align with SDG codes where possible |
| giz, sida, fcdo, other | Sector standards | none | — |
| usaid (legacy) | — | none | Legacy awards only; programmes now administered by the US State Department |

### A4. Pipeline

```
buildProjectContext
   → retrieveCandidates (library filter + semantic search)   ~30–60 candidates
   → callModel (structured output)                           suggestions JSON
   → validateAndScore (deterministic rules)                  warnings, quality score, fixes
   → persist KpiSuggestion rows (status = pending)
   → return to UI
```

**Step 1 — retrieveCandidates**

1. Hard filter the library: same sector(s) + `other`/cross-cutting entries + all entries whose framework is in `donorRules.requiredFrameworks`; exclude `orgPreferences.rejectedLibraryIds`.
2. Semantic ranking: embed each result statement and rank library entries by cosine similarity (pgvector). Take the top 8 per result, de-duplicated.
3. Fallback when no embedding key is configured or the vector query fails: keyword overlap on `name`, `definition` and `tags`. The feature must work without embeddings.
4. Always add accountability entries (AC-01 … AC-05) for humanitarian projects.

Embeddings: Anthropic does not offer an embeddings model; its docs point to Voyage AI. Use `voyage-4` (1024 dimensions, multilingual) or `voyage-4-lite` for cost. Change the `embedding` column from `vector(1536)` to `vector(1024)`. Embed library entries once at seed time and on edit (`input_type: "document"`); embed result statements at query time (`input_type: "query"`). Keep the provider behind an interface (`EmbeddingProvider`) so it can be swapped.

**Step 2 — callModel**

- Model: `claude-sonnet-5-5` for framework-level and result-level suggestions; `claude-haiku-5-5` for alternatives and for the monitoring explanations. Put model IDs in config (`AI_MODEL_MAIN`, `AI_MODEL_FAST`), never hard-coded in services.
- Use **structured outputs** (`output_config.format` with `type: "json_schema"`) so the response always matches the schema below. Upgrade `@anthropic-ai/sdk` to the current version first; the existing code uses 0.39 and parses free text with `cleanJsonResponse`, which breaks on malformed JSON.
- System prompt = role paragraph + sections 1–12 of `knowledge/me-foundations.md` (loaded from file at startup, versioned). Use prompt caching on the system prompt because it is identical across calls.
- User message = the `ProjectContext` JSON + the candidate list (id, name, definition, unit, level, methods, frequency, disaggregation, standardReference) + explicit instructions:
  - Prefer candidates; adapt wording to the project; keep the candidate `libraryId`.
  - Write a custom indicator only when no candidate fits; set `isCustom: true` and explain why in `customReason`.
  - Respect `donorRules.maxIndicatorsPerResult`.
  - Never invent baselines or targets (me-foundations §6). Fill `targetSuggestion` only from `documentFacts` (with `targetBasis: "document"`), from a recognised standard threshold (`"standard_threshold"`), or as a method description (`"method_only"`).
  - Arabic name in Modern Standard Arabic.
  - 2–4 suggestions per outcome, 2–3 per output, 1–2 per impact statement, unless the donor cap is lower.

**Output JSON schema** (respects structured-output limits: every object has `additionalProperties: false`; only two nullable unions; no numeric or length constraints):

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["suggestions", "frameworkWarnings"],
  "properties": {
    "suggestions": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["resultId", "level", "libraryId", "isCustom", "customReason", "name", "nameAr", "definition", "unit", "numerator", "denominator", "direction", "disaggregation", "method", "frequency", "meansOfVerification", "baselineSuggestion", "baselineBasis", "targetSuggestion", "targetBasis", "standardReferenceCode", "rationale", "qualityNotes", "confidence"],
        "properties": {
          "resultId": { "type": "string", "description": "id of the results-chain node this indicator measures" },
          "level": { "type": "string", "enum": ["impact", "outcome", "output"] },
          "libraryId": { "type": ["string", "null"], "description": "library id of the candidate used, or null for a custom indicator" },
          "isCustom": { "type": "boolean" },
          "customReason": { "type": "string", "description": "empty string when isCustom is false" },
          "name": { "type": "string", "description": "neutral wording, no target or direction" },
          "nameAr": { "type": "string" },
          "definition": { "type": "string" },
          "unit": { "type": "string", "enum": ["number", "percent", "score", "litres_per_person_per_day", "hectares", "dunums", "megawatts", "tonnes_co2eq", "currency_ils", "kg_per_dunum", "yes_no"] },
          "numerator": { "type": "string", "description": "empty string when unit is not percent" },
          "denominator": { "type": "string", "description": "empty string when unit is not percent" },
          "direction": { "type": "string", "enum": ["increase", "decrease", "maintain"] },
          "disaggregation": { "type": "array", "items": { "type": "string" } },
          "method": { "type": "string", "enum": ["hh_survey", "fgd", "kii", "observation", "document_review", "participatory", "secondary_data"] },
          "frequency": { "type": "string", "enum": ["monthly", "quarterly", "biannual", "annual", "per_cohort", "baseline_endline"] },
          "meansOfVerification": { "type": "string" },
          "baselineSuggestion": { "type": "string", "description": "empty string if none" },
          "baselineBasis": { "type": "string", "enum": ["document", "none"] },
          "targetSuggestion": { "type": "string", "description": "a value, a standard threshold, or a target-setting method; empty if none" },
          "targetBasis": { "type": "string", "enum": ["document", "standard_threshold", "method_only", "none"] },
          "standardReferenceCode": { "type": ["string", "null"], "description": "e.g. 'GERF 2.38', 'IASC MHPSS O5.4'" },
          "rationale": { "type": "string", "description": "2–3 sentences: why this indicator fits this result and this donor" },
          "qualityNotes": { "type": "array", "items": { "type": "string" } },
          "confidence": { "type": "string", "enum": ["high", "medium", "low"] }
        }
      }
    },
    "frameworkWarnings": { "type": "array", "items": { "type": "string" }, "description": "gaps the model notices, e.g. an outcome with no measurable change" }
  }
}
```

Handle `stop_reason: "max_tokens"` (retry once with a higher limit or split by result) and `stop_reason: "refusal"` (return a friendly error). Compare enum values case-insensitively.

**Step 3 — validateAndScore** (pure functions in `src/services/kpi/validate.ts`, fully unit-tested)

| Rule | Action |
|---|---|
| `libraryId` given but not in the library | Set to null, `isCustom = true`, add warning |
| `isCustom` true and `customReason` empty | Add warning, −10 |
| Name contains a target or direction ("increase to", "by 20%", "reach", digits followed by %) | Add warning "move target out of the name", −15 |
| Name contains " and " joining two measurements (heuristic) | Add warning "may be double-barrelled", −10 |
| `unit = percent` with empty numerator or denominator | Add warning, −15 |
| Indicator about people (name matches people/persons/households/women/men/children/youth/students/farmers/participants/beneficiaries, or Arabic equivalents) without `sex` or `sex_of_household_head` in disaggregation | Add `sex` automatically, add info note |
| `targetBasis = "document"` but the value does not appear in any `documentFacts` excerpt | Change to `method_only`, clear the value, add warning "target not found in documents" |
| `baselineBasis = "document"` but value not found | Same treatment |
| Output indicator using `hh_survey` as method | Info note "outputs are usually counted from records" |
| Impact indicator not using `secondary_data` | Info note |
| More suggestions for one result than `maxIndicatorsPerResult` | Keep highest confidence/score, drop the rest with a framework warning |
| Near-duplicate of an existing indicator (normalised text equal, or embedding cosine ≥ 0.92) | Drop, add framework warning |
| Humanitarian project and no accountability indicator in framework or suggestions | Add framework warning and append AC-01 as a suggestion |

Quality score = 100 minus penalties (floor 0). Show as a badge: 85–100 "Strong", 65–84 "Review", below 65 "Weak".

### A5. Data model additions (Prisma)

```prisma
model ResultNode {            // results chain, replaces untyped JSON
  id          String   @id @default(uuid())
  frameworkId String
  framework   Framework @relation(fields: [frameworkId], references: [id], onDelete: Cascade)
  parentId    String?
  parent      ResultNode?  @relation("ResultTree", fields: [parentId], references: [id])
  children    ResultNode[] @relation("ResultTree")
  level       IndicatorLevel
  code        String       // "Goal", "O1", "O1.1"
  text        String
  textAr      String?
  sortOrder   Int          @default(0)
  indicators  Indicator[]
}

model KpiSuggestion {
  id            String   @id @default(uuid())
  projectId     String
  frameworkId   String
  resultId      String?
  payload       Json      // validated suggestion object
  qualityScore  Int
  warnings      Json
  libraryId     String?
  status        SuggestionStatus @default(pending) // pending | accepted | edited_accepted | rejected | expired
  model         String
  promptVersion String
  createdAt     DateTime @default(now())
  decidedAt     DateTime?
  decidedBy     String?
  rejectReason  String?   // not_relevant | too_costly_to_measure | donor_not_required | duplicate | wording | other
}
```

Add to `Indicator`: `resultId`, `definition`, `calculation Json?`, `direction`, `disaggregation Json?`, `meansOfVerification`, `baselineDate`, `baselineMethod`, `targetJustification`, `assumptions`, `libraryId`, `standardReferenceCode`, `provenance` (library | ai_suggested | ai_generated | imported | manual), `aiModel`, `promptVersion`.

Replace `METemplate` with `IndicatorLibraryEntry` mirroring `knowledge/indicator-library.json` (keep a `version` column; seed is idempotent by `id`).

### A6. API

| Method & path | Purpose |
|---|---|
| `POST /api/projects/:id/kpi-suggestions` body `{ scope: 'framework' | 'result' | 'alternatives', resultId?, indicatorId? }` | Runs the pipeline (queued job when scope = framework; synchronous for one result if < 20 s, else queued) |
| `GET /api/projects/:id/kpi-suggestions?status=pending` | List suggestions |
| `POST /api/kpi-suggestions/:id/accept` body `{ edits? }` | Creates the Indicator (provenance set), marks suggestion accepted/edited_accepted |
| `POST /api/kpi-suggestions/:id/reject` body `{ reason, note? }` | Records feedback |
| `GET /api/indicator-library?sector=&q=&framework=` | Browse the library manually |

All routes check that the project belongs to `req.user.organizationId`.

### A7. UI

- On the framework page, each result card shows its indicators and a **Suggest KPIs** button. Suggestions slide in as cards beneath the result.
- Each card shows: name (EN/AR toggle), level badge, standard badge (e.g., "EU GERF 2.38") or "Custom", quality badge, method pill, frequency, disaggregation chips, a one-line rationale with "Why?" to expand, warnings in amber.
- Actions: **Accept**, **Edit & accept** (opens the indicator form pre-filled), **Reject** (asks for a reason with one-tap chips), **Show alternatives**.
- An "AI suggested — review before approval" label stays on accepted indicators until an org admin approves the framework.
- Loading state uses progress steps ("Reading your results chain…", "Matching standard indicators…", "Checking quality…"), not a bare spinner.
- Everything works in Arabic with right-to-left layout.

### A8. Evaluation (must pass before release)

`knowledge/kpi-eval-cases.json` contains realistic test projects with assertions. Add `npm run eval:kpi` which runs the full pipeline against each case (real model, small budget) and reports:

- **Schema validity** — 100% required.
- **Assertion pass rate** — target ≥ 90% across cases.
- **Library usage** — share of suggestions with a valid `libraryId`; target ≥ 70% where candidates exist.
- **Hallucinated targets** — suggestions where `targetBasis = "document"` but the value is absent from the documents; target 0 after validation.
- **Average quality score** — target ≥ 80.
- **Cost and latency per run** — logged; result-level call target under 15 seconds.

Store each eval run as JSON in `eval-results/` (git-ignored) and print a summary table. Re-run after any prompt or library change; record the `promptVersion`.

---

## Part B — Active Monitoring

### B1. What "active" means

The system checks every active project daily, without anyone asking, and creates **insights**: short, specific messages with a severity, a reason and a recommended action. Users see them on the dashboard, in notifications and in a weekly email digest. AI is used only to explain and recommend; detection is rule-based so it is predictable and testable.

### B2. Data model

```prisma
model Insight {
  id          String   @id @default(uuid())
  projectId   String
  indicatorId String?
  ruleId      String          // e.g. "R3_OFF_TRACK"
  severity    InsightSeverity // info | warning | critical
  title       String
  detail      String
  recommendation String
  aiExplanation  String?      // optional, from claude-haiku-5-5
  status      InsightStatus @default(open) // open | acknowledged | resolved | dismissed
  fingerprint String  @unique // ruleId + entity + period, prevents duplicates
  createdAt   DateTime @default(now())
  resolvedAt  DateTime?
}
```

### B3. Rules (all thresholds configurable per organisation)

| ID | Rule | Severity |
|---|---|---|
| R1_MISSING_BASELINE | Outcome or impact indicator without a baseline 60 days after project start (ECHO projects: also before the interim report date) | warning → critical after 120 days |
| R2_DATA_OVERDUE | Last data point older than the indicator's frequency window + 15-day grace | warning |
| R3_OFF_TRACK | Actual progress vs expected linear trajectory, direction-aware: progress ratio < 0.8 → at risk; < 0.6 → off track. Expected value = baseline + (target − baseline) × elapsed share of the indicator period | warning / critical |
| R4_DISAGG_GAP | People-level indicator whose latest data point has no sex breakdown | warning |
| R5_FRAMEWORK_GAP | Outcome or output with no indicator; result exceeding donor cap; humanitarian project with no accountability indicator | warning |
| R6_DATA_ANOMALY | Percent outside 0–100; negative counts; value more than 3× or less than ⅓ of the previous value | warning |
| R7_UPCOMING | Assessment, milestone or report due within 14 days | info |
| R8_QUAL_SIGNAL | Two or more qualitative entries in 30 days, linked to the same indicator, coded negative | info |

Keep each rule a pure function `(projectSnapshot, now, config) => InsightDraft[]` with unit tests, including direction-aware cases (decrease indicators such as rCSI).

### B4. Job

- BullMQ repeatable job `monitoring-scan`, daily at 05:00 Asia/Hebron, iterates active projects in batches.
- Upsert insights by `fingerprint`; auto-resolve insights whose condition no longer holds.
- For new critical R3 insights, call `claude-haiku-5-5` with aggregates only (indicator values over time, target, disaggregated totals, linked qualitative themes) to produce a 3-sentence explanation and two practical recommendations. Label it "AI explanation" in the UI.
- Weekly digest email (Resend) every Sunday 08:00 Asia/Hebron (the regional work week starts on Sunday) to org admins and M&E officers: counts by severity, top five insights, links.

### B5. UI

- Dashboard: an "Attention needed" panel listing open insights by severity, with one-click actions (Add data, Set baseline, Suggest KPIs, Acknowledge, Dismiss with reason).
- Indicator rows show a status dot driven by R3, with a tooltip showing expected vs actual.
- Notification bell shows new insights; the existing Notification model can reference `insightId`.
