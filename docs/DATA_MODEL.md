# Data model (Phase 2)

What Phase 2 adds to the database, in plain language, and how to roll it out to a shared or Supabase database. The schema itself is `prisma/schema.prisma`; the M&E rules behind it are in `knowledge/me-foundations.md` §1–6.

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
| `code` | short label shown in the logframe, e.g. `Goal`, `O1`, `O1.1` |
| `text`, `textAr` | the result statement in English and Arabic |
| `sortOrder` | order among siblings |

**Hierarchy rule** (enforced by the API, `src/services/indicators/hierarchy.ts`): a parent is optional; when present it is in the same framework and exactly one level up — an outcome's parent is an impact, an output's parent an outcome, an activity's parent an output. An impact never has a parent.

Each indicator can point to the result it measures (`Indicator.resultId`). A node with children cannot be deleted (409); deleting a node without children unlinks its indicators (`ON DELETE SET NULL`).

**Existing frameworks.** The old framework generator never stored the results chain, so the migration gives every framework one placeholder node per level its indicators use and links each indicator to it:

| Level | Code | Text |
|---|---|---|
| impact | `Goal` | Impact indicators (results chain to be completed) — مؤشرات الأثر (سلسلة النتائج قيد الاستكمال) |
| outcome | `O` | Outcome indicators (results chain to be completed) — مؤشرات المحصلات (سلسلة النتائج قيد الاستكمال) |
| output | `OP` | Output indicators (results chain to be completed) — مؤشرات المخرجات (سلسلة النتائج قيد الاستكمال) |
| activity | `A` | Activity indicators (results chain to be completed) — مؤشرات الأنشطة (سلسلة النتائج قيد الاستكمال) |

Placeholders are chained so the hierarchy rule holds (the outcome placeholder's parent is the framework's impact placeholder if there is one, and so on). M&E officers replace them with the real results in the framework editor. The Arabic texts are drafts for review by a native-speaking M&E specialist.

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
| `libraryId` | library id or null | the library entry it came from, e.g. `FS-01` |
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

Clients may set only `manual`, `library` or `imported`; the `ai_*` values are set by the server (the API answers 400 otherwise). The migration marks indicators of frameworks whose `aiModelUsed` is empty or `manual` as `manual`, and all others as `ai_generated` with `aiModel` = the framework's `aiModelUsed`.

## 4. Disaggregated data (`DataPoint.breakdown`)

A data point can carry its value broken down by group, one object per dimension:

```json
{
  "sex": { "female": 120, "male": 98 },
  "disability": { "yes": 12, "no": 206 }
}
```

Values are numbers. When the indicator counts people or things, each dimension's categories must add up to the data point's `value` (here 218); otherwise the API answers 400 with a clear message. `breakdown` is optional and empty for all existing data points.

## 5. Projects and enums

- `Project.sectors` lists all sectors of a project; the primary `sector` is always included. The migration sets `sectors = [sector]` for existing projects.
- `Project.humanitarian` (default `false`) drives accountability rules and ECHO behaviour.
- `Sector` gains `mhpss`, `cash`, `shelter`, `climate_energy`.
- `DonorType` gains `echo`, `wfp`, `unfpa`, `fcdo`, `un_women`. `usaid` is kept as a legacy value (shown as "USAID (legacy)"; USAID stopped administering awards on 1 July 2025).
- New enums `IndicatorDirection` and `IndicatorProvenance`.

## 6. Indicator library (`IndicatorLibraryEntry`)

The seed library of standard and common-practice indicators. The source of truth is `knowledge/indicator-library.json` (63 entries, version in `meta.version`); the table mirrors it: `id` (e.g. `FS-01`), `sector`, `tags`, `level`, `name`, `nameAr`, `definition`, `unit`, `calculation`, `direction`, `disaggregation`, `methods`, `frequency`, `meansOfVerification`, `standardReference` (`{ framework, code, url }`), `standardFramework` (copy of `standardReference.framework`, for filtering), `isStandard`, `notes`, `version`, and `embedding vector(1024)` (filled in Phase 3).

- Load or refresh it with `npm run seed:library`. It upserts by `id`, updates only entries whose content changed, never deletes, and running it twice changes nothing. It is safe in any environment.
- The API reads it at `GET /api/indicator-library` (filters `sector`, `level`, `framework`, `q`, `isStandard`) and `GET /api/indicator-library/:id`. The library is global (not owned by an organisation); both routes need a signed-in user.

## 7. Rolling out to a shared or Supabase database

Locally, `npx prisma db push` is enough. Shared databases get the reviewed SQL file `prisma/sql/2026-10-11_phase2_data_model.sql`, which upgrades a database matching the schema at commit `022e09a` (Phase 0/1). It:

1. adds the new enum values (outside the transaction, safe to repeat);
2. in one transaction: refuses to run if Phase 2 is already applied, applies the DDL generated by `prisma migrate diff`, fills `Project.sectors`, creates the placeholder results and links every indicator, sets provenance, enables row level security (no policies) on `ResultNode` and `IndicatorLibraryEntry`, and checks the result — any failure rolls everything back.

Steps (CLAUDE.md rule 8: test on a development branch first and show the SQL before touching a shared database). `DIRECT_URL` is the shared database's direct connection (port 5432, not the pooler); `BRANCH_URL` / `BRANCH_DIRECT_URL` are the branch's.

1. **Prove it locally.** `scripts/verify-phase2-migration.sh` must end with `PASS`. It runs the file on a fresh database and on a copy of the old seed and checks row counts, checksums, links, the hierarchy rule, provenance, RLS, a refused second run and that `prisma migrate diff` reports no drift.
2. **Check the starting point and back up** (resume the Supabase project if it is paused). The file expects the Phase 0 schema: if `psql "$DIRECT_URL" -Atc 'SELECT to_regclass($$public."WebhookToken"$$)'` prints nothing, apply `prisma/sql/2026-10-11_phase0_webhook_tokens.sql` first (same branch-first procedure). Then:
   `pg_dump "$DIRECT_URL" --schema=public -Fc --no-owner --no-privileges -f raqib-before-phase2.dump`
   `pg_dump "$DIRECT_URL" --schema=public --data-only -Fc -f raqib-data-before-phase2.dump`
   The dumps contain personal data: keep them private and delete them when no longer needed.
3. **Create a Supabase development branch** (Dashboard → Branches → Create branch, or `supabase branches create phase2-data-model`). A new branch has none of the main data, so give it the current schema and a copy of the data:
   ```bash
   git show 022e09a:prisma/schema.prisma > /tmp/schema-022e09a.prisma
   DATABASE_URL="$BRANCH_DIRECT_URL" DIRECT_URL="$BRANCH_DIRECT_URL" npx prisma db push --schema /tmp/schema-022e09a.prisma --skip-generate
   pg_restore --data-only --no-owner --exit-on-error -d "$BRANCH_DIRECT_URL" raqib-data-before-phase2.dump
   ```
   If beneficiary data must not be copied to the branch, skip the `pg_restore` and add a few synthetic projects, frameworks and indicators instead.
4. **Run the SQL on the branch**, without `--single-transaction`:
   `psql "$BRANCH_DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/2026-10-11_phase2_data_model.sql`
   It ends with `COMMIT`. If it stops with `type "vector" does not exist`, pgvector lives in the `extensions` schema: add `-c 'SET search_path TO public, extensions'` before `-f`.
5. **Check the branch:**
   - no drift: `DATABASE_URL="$BRANCH_DIRECT_URL" npx prisma migrate diff --from-url "$BRANCH_DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` (exit code 0);
   - `SELECT count(*) FROM "Indicator" WHERE "resultId" IS NULL;` returns 0;
   - `SELECT count(*) FROM "Project" WHERE NOT ("sector" = ANY ("sectors"));` returns 0;
   - `DATABASE_URL="$BRANCH_URL" DIRECT_URL="$BRANCH_DIRECT_URL" npm run seed:library` reports 63 entries; a second run reports 0 created and 0 updated;
   - point a test API and the frontend at the branch and open an existing framework: indicators appear under the placeholder results.
6. **Get approval** for the SQL and the branch results, then apply to the shared database in a quiet period with the same `psql` command and the shared `DIRECT_URL`. The transaction takes seconds at current data volumes; it briefly locks `Project`, `Indicator` and `DataPoint` while columns are added.
7. **Load the library** on the shared database: `npm run seed:library`.
8. **Deploy the Phase 2 API, then the frontend.** The old API keeps working on the new schema (every new column is optional or has a default). Projects created by the old API between steps 6 and 8 get empty `sectors`; fix them after the deploy with
   `UPDATE "Project" SET "sectors" = ARRAY["sector"] WHERE cardinality("sectors") = 0;`
   Indicators created in that window have no result yet (allowed) and provenance `manual`; deploy right after step 7 to keep the window short.
9. **Clean up:** delete the development branch, record the date in the status table of `docs/BUILD_GUIDE.md`, and delete the dumps according to the data-retention policy.

**Rolling back.** Prefer rolling forward: the change is additive and the previous API version runs on the new schema, so reverting the code is enough. Removing the new tables, columns or enum values would need a separate reviewed script and explicit approval (no drops without approval); the dump from step 2 is the last resort.
