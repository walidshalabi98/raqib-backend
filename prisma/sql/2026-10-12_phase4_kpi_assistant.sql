-- Phase 4: KPI Assistant. Adds KpiSuggestionRun (one "Suggest KPIs" request: status, progress step, run-level
-- warnings, cost) and KpiSuggestion (suggested indicators and the feedback on them: accepted, edited, rejected with a
-- reason, expired), with their four enum types. Nothing else changes (knowledge/kpi-assistant-spec.md §A5).
--
-- Order: apply AFTER the Phase 0, Phase 2 and Phase 3 files. Upgrades a database that matches prisma/schema.prisma at
-- commit f010e7f (Phase 3) to the Phase 4 schema; the guard below refuses to run (and changes nothing) when Phase 3 is
-- missing, when Phase 4 is already applied, or when it is partly applied (a leftover type or the run table).
-- Additive only: two new tables and four new enum types; no existing table, column or value changes; no data moves.
--
-- DDL generated with (unchanged, section 2):
--   prisma migrate diff --from-schema-datamodel <schema at f010e7f> --to-schema-datamodel prisma/schema.prisma --script
-- Everything runs in one transaction: the guard, the generated DDL, row level security on the new tables and a
-- self-check that rolls everything back if it fails. scripts/verify-migrations.sh checks that
-- `prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma` reports no drift afterwards.
--
-- Delete behaviour (deliberate; docs/DATA_MODEL.md §11): a framework or project deleted -> its runs and suggestions go
-- with it (CASCADE); a run cannot be deleted while it has suggestions (KpiSuggestion_runId_fkey is NO ACTION:
-- suggestions are feedback history and runs are never pruned); a result, indicator or library entry deleted -> the
-- link is emptied (SET NULL), so rejected suggestions stay as feedback.
--
-- Locks: creating the foreign keys takes SHARE ROW EXCLUSIVE locks on Project, Framework, ResultNode, Indicator and
-- IndicatorLibraryEntry until COMMIT (milliseconds: the new tables are empty and nothing is scanned). Reads of those
-- tables carry on; writes to them wait meanwhile. lock_timeout makes the file give up fast (nothing changes) when an
-- open write transaction holds one of them, instead of queueing every later write behind it; run it again later.
--
-- How to run (docs/DATA_MODEL.md §9): rehearse on a throwaway Supabase project with the dev seed (free plan: no
-- branches), then, with the owner's approval, on the shared database:
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/2026-10-12_phase4_kpi_assistant.sql
-- Do not add --single-transaction (the file manages its own transaction). Through the Supabase SQL editor the file can
-- be sent whole (it adds no enum value to an existing type). Apply it BEFORE deploying the Phase 4 API: its KPI routes
-- and framework generation need the tables.
-- Proven locally on a fresh database, on a copy of the seed after the Phase 2 and Phase 3 files, on the full rollout
-- order and with pgvector in an `extensions` schema as on Supabase, by scripts/verify-migrations.sh.

BEGIN;

-- Give up after 5 seconds of waiting for a lock (the whole transaction is rolled back). Reverts at COMMIT/ROLLBACK.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Guard: refuse to run twice, half-applied or out of order (the transaction is rolled back and nothing changes)
-- ---------------------------------------------------------------------------------------------------------------

DO $$
DECLARE
  leftovers text;
BEGIN
  IF to_regclass('public."KpiSuggestion"') IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 4 migration already applied: table "KpiSuggestion" exists. Nothing was changed.';
  END IF;
  -- Anything else this file creates, left over from a half-done attempt (e.g. a partial `prisma db push`).
  SELECT string_agg(s.what, ', ' ORDER BY s.what) INTO leftovers
  FROM (
    SELECT 'type "SuggestionStatus"' AS what WHERE to_regtype('public."SuggestionStatus"') IS NOT NULL
    UNION ALL
    SELECT 'type "SuggestionRejectReason"' WHERE to_regtype('public."SuggestionRejectReason"') IS NOT NULL
    UNION ALL
    SELECT 'type "KpiRunScope"' WHERE to_regtype('public."KpiRunScope"') IS NOT NULL
    UNION ALL
    SELECT 'type "KpiRunStatus"' WHERE to_regtype('public."KpiRunStatus"') IS NOT NULL
    UNION ALL
    SELECT 'table "KpiSuggestionRun"' WHERE to_regclass('public."KpiSuggestionRun"') IS NOT NULL
  ) s;
  IF leftovers IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 4 migration already partly applied: % exist(s) without table "KpiSuggestion". Nothing was changed; compare the database with prisma/schema.prisma first.', leftovers;
  END IF;
  IF to_regclass('public."AiCall"') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'Framework' AND column_name = 'generationError') THEN
    RAISE EXCEPTION 'Phase 4 migration needs the Phase 3 SQL first (prisma/sql/2026-10-12_phase3_ai_foundation.sql). Nothing was changed.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Generated DDL
-- ---------------------------------------------------------------------------------------------------------------

-- For the self-check: the column count of every table that exists before this file (session-local; gone when the
-- session ends). Phase 4 must not add, remove or change a column of any of them.
CREATE TEMP TABLE raqib_phase4_columns_before AS
SELECT c.relname::text AS table_name, count(a.attnum) AS columns
FROM pg_class c
LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
GROUP BY c.relname;

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('pending', 'accepted', 'edited_accepted', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "SuggestionRejectReason" AS ENUM ('not_relevant', 'too_costly_to_measure', 'donor_not_required', 'duplicate', 'wording', 'other');

-- CreateEnum
CREATE TYPE "KpiRunScope" AS ENUM ('framework', 'result', 'alternatives');

-- CreateEnum
CREATE TYPE "KpiRunStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "KpiSuggestionRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "frameworkId" TEXT NOT NULL,
    "scope" "KpiRunScope" NOT NULL,
    "resultId" TEXT,
    "sourceIndicatorId" TEXT,
    "sourceSuggestionId" TEXT,
    "status" "KpiRunStatus" NOT NULL DEFAULT 'running',
    "step" TEXT NOT NULL DEFAULT 'context',
    "errorCode" TEXT,
    "error" TEXT,
    "frameworkWarnings" JSONB NOT NULL DEFAULT '[]',
    "suggestionCount" INTEGER NOT NULL DEFAULT 0,
    "retrieval" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "modelCalls" INTEGER NOT NULL DEFAULT 0,
    "embeddingCalls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(12,6),
    "latencyMs" INTEGER,
    "requestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "KpiSuggestionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KpiSuggestion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "frameworkId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "resultId" TEXT,
    "level" "IndicatorLevel" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "qualityScore" INTEGER NOT NULL,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "libraryId" TEXT,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "method" "CollectionMethod" NOT NULL,
    "alternativeOfIndicatorId" TEXT,
    "alternativeOfSuggestionId" TEXT,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'pending',
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "rejectReason" "SuggestionRejectReason",
    "rejectNote" TEXT,
    "indicatorId" TEXT,

    CONSTRAINT "KpiSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KpiSuggestionRun_projectId_createdAt_idx" ON "KpiSuggestionRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "KpiSuggestionRun_frameworkId_status_idx" ON "KpiSuggestionRun"("frameworkId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "KpiSuggestion_indicatorId_key" ON "KpiSuggestion"("indicatorId");

-- CreateIndex
CREATE INDEX "KpiSuggestion_projectId_status_idx" ON "KpiSuggestion"("projectId", "status");

-- CreateIndex
CREATE INDEX "KpiSuggestion_frameworkId_status_idx" ON "KpiSuggestion"("frameworkId", "status");

-- CreateIndex
CREATE INDEX "KpiSuggestion_resultId_idx" ON "KpiSuggestion"("resultId");

-- CreateIndex
CREATE INDEX "KpiSuggestion_runId_idx" ON "KpiSuggestion"("runId");

-- CreateIndex
CREATE INDEX "KpiSuggestion_libraryId_status_idx" ON "KpiSuggestion"("libraryId", "status");

-- AddForeignKey
ALTER TABLE "KpiSuggestionRun" ADD CONSTRAINT "KpiSuggestionRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiSuggestionRun" ADD CONSTRAINT "KpiSuggestionRun_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "Framework"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiSuggestionRun" ADD CONSTRAINT "KpiSuggestionRun_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ResultNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiSuggestionRun" ADD CONSTRAINT "KpiSuggestionRun_sourceIndicatorId_fkey" FOREIGN KEY ("sourceIndicatorId") REFERENCES "Indicator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiSuggestionRun" ADD CONSTRAINT "KpiSuggestionRun_sourceSuggestionId_fkey" FOREIGN KEY ("sourceSuggestionId") REFERENCES "KpiSuggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiSuggestion" ADD CONSTRAINT "KpiSuggestion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiSuggestion" ADD CONSTRAINT "KpiSuggestion_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "Framework"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiSuggestion" ADD CONSTRAINT "KpiSuggestion_runId_fkey" FOREIGN KEY ("runId") REFERENCES "KpiSuggestionRun"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiSuggestion" ADD CONSTRAINT "KpiSuggestion_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ResultNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiSuggestion" ADD CONSTRAINT "KpiSuggestion_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "IndicatorLibraryEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiSuggestion" ADD CONSTRAINT "KpiSuggestion_alternativeOfIndicatorId_fkey" FOREIGN KEY ("alternativeOfIndicatorId") REFERENCES "Indicator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiSuggestion" ADD CONSTRAINT "KpiSuggestion_alternativeOfSuggestionId_fkey" FOREIGN KEY ("alternativeOfSuggestionId") REFERENCES "KpiSuggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiSuggestion" ADD CONSTRAINT "KpiSuggestion_indicatorId_fkey" FOREIGN KEY ("indicatorId") REFERENCES "Indicator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Row level security
-- ---------------------------------------------------------------------------------------------------------------

-- As for every new table since Phase 2: Supabase exposes the public schema through its Data API, so enable RLS (with
-- no policies) and the tables are never readable or writable with the anon key. Prisma connects as the table owner
-- and is unaffected.
ALTER TABLE "KpiSuggestionRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KpiSuggestion" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Self-check: any failure rolls back the whole transaction
-- ---------------------------------------------------------------------------------------------------------------

DO $$
DECLARE
  n integer;
  problems text;
BEGIN
  IF to_regclass('public."KpiSuggestionRun"') IS NULL OR to_regclass('public."KpiSuggestion"') IS NULL THEN
    RAISE EXCEPTION 'Phase 4 self-check failed: table "KpiSuggestionRun" or "KpiSuggestion" is missing';
  END IF;

  -- The new tables start empty.
  SELECT (SELECT count(*) FROM "KpiSuggestionRun") + (SELECT count(*) FROM "KpiSuggestion") INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'Phase 4 self-check failed: % row(s) in the new tables (they must start empty)', n;
  END IF;

  -- Enum labels, exactly and in order (the application and the frontend rely on these values).
  SELECT string_agg(format('%s is [%s], expected [%s]', e.typ, coalesce(l.labels, 'missing'), e.expected), '; ' ORDER BY e.typ)
  INTO problems
  FROM (VALUES
    ('SuggestionStatus', 'pending,accepted,edited_accepted,rejected,expired'),
    ('SuggestionRejectReason', 'not_relevant,too_costly_to_measure,donor_not_required,duplicate,wording,other'),
    ('KpiRunScope', 'framework,result,alternatives'),
    ('KpiRunStatus', 'running,completed,failed')
  ) AS e(typ, expected)
  LEFT JOIN LATERAL (
    SELECT string_agg(pe.enumlabel::text, ',' ORDER BY pe.enumsortorder) AS labels
    FROM pg_enum pe JOIN pg_type pt ON pt.oid = pe.enumtypid
    WHERE pt.typname = e.typ AND pt.typnamespace = 'public'::regnamespace
  ) l ON true
  WHERE l.labels IS DISTINCT FROM e.expected;
  IF problems IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 4 self-check failed: enum labels differ: %', problems;
  END IF;

  -- Foreign keys by name: table, referenced table, ON DELETE (c cascade, n set null, a no action) and ON UPDATE
  -- CASCADE. No foreign key missing, none extra.
  SELECT string_agg(coalesce(x.name, f.conname::text), ', ' ORDER BY coalesce(x.name, f.conname::text)) INTO problems
  FROM (VALUES
    ('KpiSuggestion', 'KpiSuggestion_projectId_fkey', 'Project', 'c'),
    ('KpiSuggestion', 'KpiSuggestion_frameworkId_fkey', 'Framework', 'c'),
    ('KpiSuggestion', 'KpiSuggestion_runId_fkey', 'KpiSuggestionRun', 'a'),
    ('KpiSuggestion', 'KpiSuggestion_resultId_fkey', 'ResultNode', 'n'),
    ('KpiSuggestion', 'KpiSuggestion_libraryId_fkey', 'IndicatorLibraryEntry', 'n'),
    ('KpiSuggestion', 'KpiSuggestion_indicatorId_fkey', 'Indicator', 'n'),
    ('KpiSuggestion', 'KpiSuggestion_alternativeOfIndicatorId_fkey', 'Indicator', 'n'),
    ('KpiSuggestion', 'KpiSuggestion_alternativeOfSuggestionId_fkey', 'KpiSuggestion', 'n'),
    ('KpiSuggestionRun', 'KpiSuggestionRun_projectId_fkey', 'Project', 'c'),
    ('KpiSuggestionRun', 'KpiSuggestionRun_frameworkId_fkey', 'Framework', 'c'),
    ('KpiSuggestionRun', 'KpiSuggestionRun_resultId_fkey', 'ResultNode', 'n'),
    ('KpiSuggestionRun', 'KpiSuggestionRun_sourceIndicatorId_fkey', 'Indicator', 'n'),
    ('KpiSuggestionRun', 'KpiSuggestionRun_sourceSuggestionId_fkey', 'KpiSuggestion', 'n')
  ) AS x(tbl, name, ref, del)
  FULL JOIN (
    SELECT conname, conrelid, confrelid, confdeltype, confupdtype FROM pg_constraint
    WHERE contype = 'f' AND conrelid IN ('public."KpiSuggestion"'::regclass, 'public."KpiSuggestionRun"'::regclass)
  ) f ON f.conname = x.name
  WHERE x.name IS NULL OR f.conname IS NULL
     OR f.conrelid <> format('public.%I', x.tbl)::regclass
     OR f.confrelid <> format('public.%I', x.ref)::regclass
     OR f.confdeltype::text <> x.del
     OR f.confupdtype::text <> 'c';
  IF problems IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 4 self-check failed: foreign key(s) missing, extra or with the wrong target or behaviour: %', problems;
  END IF;

  -- One suggestion per accepted indicator.
  SELECT count(*) INTO n
  FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
  WHERE ic.relname = 'KpiSuggestion_indicatorId_key' AND ic.relnamespace = 'public'::regnamespace
    AND i.indrelid = 'public."KpiSuggestion"'::regclass AND i.indisunique AND i.indnatts = 1
    AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public."KpiSuggestion"'::regclass AND attname = 'indicatorId');
  IF n <> 1 THEN
    RAISE EXCEPTION 'Phase 4 self-check failed: unique index "KpiSuggestion_indicatorId_key" on "KpiSuggestion"("indicatorId") is missing';
  END IF;

  SELECT string_agg(relname::text, ', ' ORDER BY relname) INTO problems FROM pg_class
  WHERE oid IN ('public."KpiSuggestionRun"'::regclass, 'public."KpiSuggestion"'::regclass) AND NOT relrowsecurity;
  IF problems IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 4 self-check failed: row level security is not enabled on %', problems;
  END IF;

  -- Additive only: every table that existed before keeps its column count, and the only new tables are the two above.
  SELECT string_agg(format('%s (%s columns before, %s now)', b.table_name, b.columns, coalesce(a.columns::text, 'table gone')), ', ' ORDER BY b.table_name)
  INTO problems
  FROM raqib_phase4_columns_before b
  LEFT JOIN (
    SELECT c.relname::text AS table_name, count(a.attnum) AS columns
    FROM pg_class c
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    GROUP BY c.relname
  ) a USING (table_name)
  WHERE a.columns IS DISTINCT FROM b.columns;
  IF problems IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 4 self-check failed: pre-existing table(s) changed: %', problems;
  END IF;
  SELECT string_agg(c.relname::text, ', ' ORDER BY c.relname) INTO problems FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    AND c.relname::text NOT IN ('KpiSuggestionRun', 'KpiSuggestion')
    AND NOT EXISTS (SELECT 1 FROM raqib_phase4_columns_before b WHERE b.table_name = c.relname::text);
  IF problems IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 4 self-check failed: unexpected new table(s): %', problems;
  END IF;
END
$$;

COMMIT;
