-- Phase 2: data model for donor-grade M&E (results chain, indicator reference sheet, disaggregated data,
-- multiple sectors per project, humanitarian flag, indicator library).
--
-- Upgrades a database that matches prisma/schema.prisma at commit 022e09a (Phase 0/1 main) to the Phase 2 schema.
-- Additive only: no table or column is dropped or renamed, no existing value is changed except the new columns
-- filled by the data migration below. METemplate is deprecated but kept (no table drops without approval).
--
-- DDL generated with:
--   prisma migrate diff --from-schema-datamodel <schema at 022e09a> --to-schema-datamodel prisma/schema.prisma --script
-- Changes to the generated DDL (none of them changes the resulting schema; scripts/verify-migrations.sh
-- checks that `prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma` reports no drift):
--   * the enum ADD VALUE statements come first, outside the transaction, with IF NOT EXISTS so that a re-run after
--     a failed attempt is safe (Postgres cannot use a newly added enum value in the transaction that added it);
--   * everything else runs in one transaction with a guard against applying the file twice, followed by the data
--     migration, row level security on the new tables and a self-check that rolls everything back if it fails.
--
-- How to run (see docs/DATA_MODEL.md): on a Supabase development branch first, then on the shared database:
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/2026-10-11_phase2_data_model.sql
-- Do not add --single-transaction (the file manages its own transaction). Then run `npm run seed:library`.
-- Proven locally on a fresh database and on a copy of the seed by scripts/verify-migrations.sh.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. New enum values (outside the transaction)
-- ---------------------------------------------------------------------------------------------------------------

-- AlterEnum
ALTER TYPE "Sector" ADD VALUE IF NOT EXISTS 'mhpss';
ALTER TYPE "Sector" ADD VALUE IF NOT EXISTS 'cash';
ALTER TYPE "Sector" ADD VALUE IF NOT EXISTS 'shelter';
ALTER TYPE "Sector" ADD VALUE IF NOT EXISTS 'climate_energy';

-- AlterEnum (usaid is kept as a legacy value: USAID stopped administering awards on 1 July 2025)
ALTER TYPE "DonorType" ADD VALUE IF NOT EXISTS 'echo';
ALTER TYPE "DonorType" ADD VALUE IF NOT EXISTS 'wfp';
ALTER TYPE "DonorType" ADD VALUE IF NOT EXISTS 'unfpa';
ALTER TYPE "DonorType" ADD VALUE IF NOT EXISTS 'fcdo';
ALTER TYPE "DonorType" ADD VALUE IF NOT EXISTS 'un_women';

BEGIN;

-- Refuse to run twice (the transaction is rolled back and nothing changes).
DO $$
BEGIN
  IF to_regclass('public."ResultNode"') IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 2 migration already applied: table "ResultNode" exists. Nothing was changed.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Generated DDL
-- ---------------------------------------------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "IndicatorDirection" AS ENUM ('increase', 'decrease', 'maintain');

-- CreateEnum
CREATE TYPE "IndicatorProvenance" AS ENUM ('library', 'ai_suggested', 'ai_generated', 'imported', 'manual');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "humanitarian" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sectors" "Sector"[] DEFAULT ARRAY[]::"Sector"[];

-- AlterTable
ALTER TABLE "Indicator" ADD COLUMN     "aiModel" TEXT,
ADD COLUMN     "assumptions" TEXT,
ADD COLUMN     "baselineDate" DATE,
ADD COLUMN     "baselineMethod" TEXT,
ADD COLUMN     "calculation" JSONB,
ADD COLUMN     "definition" TEXT,
ADD COLUMN     "direction" "IndicatorDirection",
ADD COLUMN     "disaggregation" JSONB,
ADD COLUMN     "intermediateTargets" JSONB,
ADD COLUMN     "libraryId" TEXT,
ADD COLUMN     "meansOfVerification" TEXT,
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "provenance" "IndicatorProvenance" NOT NULL DEFAULT 'manual',
ADD COLUMN     "resultId" TEXT,
ADD COLUMN     "standardReferenceCode" TEXT,
ADD COLUMN     "targetJustification" TEXT;

-- AlterTable
ALTER TABLE "DataPoint" ADD COLUMN     "breakdown" JSONB;

-- CreateTable
CREATE TABLE "ResultNode" (
    "id" TEXT NOT NULL,
    "frameworkId" TEXT NOT NULL,
    "parentId" TEXT,
    "level" "IndicatorLevel" NOT NULL,
    "code" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "textAr" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResultNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndicatorLibraryEntry" (
    "id" TEXT NOT NULL,
    "sector" "Sector" NOT NULL,
    "tags" TEXT[],
    "level" "IndicatorLevel" NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "definition" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "calculation" JSONB,
    "direction" "IndicatorDirection" NOT NULL,
    "disaggregation" TEXT[],
    "methods" "CollectionMethod"[],
    "frequency" "Frequency" NOT NULL,
    "meansOfVerification" TEXT NOT NULL,
    "standardReference" JSONB,
    "standardFramework" TEXT,
    "isStandard" BOOLEAN NOT NULL,
    "notes" TEXT,
    "version" TEXT NOT NULL,
    "embedding" vector(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndicatorLibraryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResultNode_frameworkId_idx" ON "ResultNode"("frameworkId");

-- CreateIndex
CREATE INDEX "ResultNode_parentId_idx" ON "ResultNode"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "ResultNode_frameworkId_code_key" ON "ResultNode"("frameworkId", "code");

-- CreateIndex
CREATE INDEX "IndicatorLibraryEntry_sector_idx" ON "IndicatorLibraryEntry"("sector");

-- CreateIndex
CREATE INDEX "IndicatorLibraryEntry_standardFramework_idx" ON "IndicatorLibraryEntry"("standardFramework");

-- CreateIndex
CREATE INDEX "Indicator_resultId_idx" ON "Indicator"("resultId");

-- AddForeignKey
ALTER TABLE "ResultNode" ADD CONSTRAINT "ResultNode_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "Framework"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResultNode" ADD CONSTRAINT "ResultNode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ResultNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Indicator" ADD CONSTRAINT "Indicator_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ResultNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Indicator" ADD CONSTRAINT "Indicator_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "IndicatorLibraryEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Data migration
-- ---------------------------------------------------------------------------------------------------------------

-- 3a. Every project lists its primary sector in `sectors`.
UPDATE "Project"
SET "sectors" = ARRAY["sector"]
WHERE "sectors" IS NULL OR cardinality("sectors") = 0;

-- 3b. The old framework generator did not store the results chain. For every framework, create one placeholder
-- result per level its indicators use, chained so the hierarchy rule holds (impact > outcome > output > activity;
-- a parent is exactly one level up in the same framework, or NULL when that level has no placeholder).
-- M&E officers replace the placeholders with the real results chain in the framework editor.
INSERT INTO "ResultNode" ("id", "frameworkId", "parentId", "level", "code", "text", "textAr", "sortOrder")
SELECT gen_random_uuid()::text, f."id", NULL, 'impact', 'Goal',
       'Impact indicators (results chain to be completed)',
       'مؤشرات الأثر (سلسلة النتائج قيد الاستكمال)', 0
FROM "Framework" f
WHERE EXISTS (SELECT 1 FROM "Indicator" i WHERE i."frameworkId" = f."id" AND i."level" = 'impact');

INSERT INTO "ResultNode" ("id", "frameworkId", "parentId", "level", "code", "text", "textAr", "sortOrder")
SELECT gen_random_uuid()::text, f."id",
       (SELECT r."id" FROM "ResultNode" r WHERE r."frameworkId" = f."id" AND r."level" = 'impact'),
       'outcome', 'O',
       'Outcome indicators (results chain to be completed)',
       'مؤشرات المحصلات (سلسلة النتائج قيد الاستكمال)', 0
FROM "Framework" f
WHERE EXISTS (SELECT 1 FROM "Indicator" i WHERE i."frameworkId" = f."id" AND i."level" = 'outcome');

INSERT INTO "ResultNode" ("id", "frameworkId", "parentId", "level", "code", "text", "textAr", "sortOrder")
SELECT gen_random_uuid()::text, f."id",
       (SELECT r."id" FROM "ResultNode" r WHERE r."frameworkId" = f."id" AND r."level" = 'outcome'),
       'output', 'OP',
       'Output indicators (results chain to be completed)',
       'مؤشرات المخرجات (سلسلة النتائج قيد الاستكمال)', 0
FROM "Framework" f
WHERE EXISTS (SELECT 1 FROM "Indicator" i WHERE i."frameworkId" = f."id" AND i."level" = 'output');

INSERT INTO "ResultNode" ("id", "frameworkId", "parentId", "level", "code", "text", "textAr", "sortOrder")
SELECT gen_random_uuid()::text, f."id",
       (SELECT r."id" FROM "ResultNode" r WHERE r."frameworkId" = f."id" AND r."level" = 'output'),
       'activity', 'A',
       'Activity indicators (results chain to be completed)',
       'مؤشرات الأنشطة (سلسلة النتائج قيد الاستكمال)', 0
FROM "Framework" f
WHERE EXISTS (SELECT 1 FROM "Indicator" i WHERE i."frameworkId" = f."id" AND i."level" = 'activity');

-- Link every indicator to its framework's placeholder for its level.
UPDATE "Indicator" i
SET "resultId" = r."id"
FROM "ResultNode" r
WHERE r."frameworkId" = i."frameworkId"
  AND r."level" = i."level"
  AND i."resultId" IS NULL;

-- 3c. Provenance: 'ai_generated' (with the framework's model id in aiModel) only for the AI framework generator's own
-- indicators, i.e. the framework stores a model id in aiModelUsed (frameworks created by hand store 'manual' or
-- nothing) AND the indicator was created at most one hour after the framework (the generator creates all its
-- indicators right after the framework). Everything else is 'manual', including indicators that people added by hand
-- to an AI-generated framework later.
UPDATE "Indicator" i
SET "provenance" = CASE
                     WHEN f."aiModelUsed" IS NOT NULL AND f."aiModelUsed" <> 'manual'
                      AND i."createdAt" <= f."generatedAt" + interval '1 hour' THEN 'ai_generated'::"IndicatorProvenance"
                     ELSE 'manual'::"IndicatorProvenance"
                   END,
    "aiModel" = CASE
                  WHEN f."aiModelUsed" IS NOT NULL AND f."aiModelUsed" <> 'manual'
                   AND i."createdAt" <= f."generatedAt" + interval '1 hour' THEN f."aiModelUsed"
                  ELSE NULL
                END
FROM "Framework" f
WHERE f."id" = i."frameworkId";

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------------------------------------------------

-- Supabase exposes the public schema through its Data API. Enable RLS (with no policies) on the new tables so they
-- are never readable or writable with the anon key. Prisma connects as the table owner and is unaffected.
ALTER TABLE "ResultNode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IndicatorLibraryEntry" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Self-check: any failure rolls back the whole transaction
-- ---------------------------------------------------------------------------------------------------------------

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM "Indicator" WHERE "resultId" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 2 self-check failed: % indicator(s) without a result', n;
  END IF;

  SELECT count(*) INTO n FROM "Project" WHERE "sectors" IS NULL OR NOT ("sector" = ANY ("sectors"));
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 2 self-check failed: % project(s) whose primary sector is not in sectors', n;
  END IF;

  SELECT count(*) INTO n
  FROM "ResultNode" c
  LEFT JOIN "ResultNode" p ON p."id" = c."parentId"
  WHERE (c."level" = 'impact' AND c."parentId" IS NOT NULL)
     OR (c."parentId" IS NOT NULL AND (
           p."frameworkId" <> c."frameworkId"
           OR (c."level", p."level") NOT IN (
                ('outcome'::"IndicatorLevel", 'impact'::"IndicatorLevel"),
                ('output'::"IndicatorLevel", 'outcome'::"IndicatorLevel"),
                ('activity'::"IndicatorLevel", 'output'::"IndicatorLevel"))));
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 2 self-check failed: % result node(s) break the hierarchy rule', n;
  END IF;

  -- Provenance (3c): aiModel is set exactly for 'ai_generated', and only for indicators of a framework with a model
  -- id that were created within one hour of the framework.
  SELECT count(*) INTO n
  FROM "Indicator" i
  JOIN "Framework" f ON f."id" = i."frameworkId"
  WHERE i."provenance" NOT IN ('manual', 'ai_generated')
     OR (i."provenance" = 'ai_generated') <> (i."aiModel" IS NOT NULL)
     OR (i."provenance" = 'ai_generated' AND (i."aiModel" IS DISTINCT FROM f."aiModelUsed" OR f."aiModelUsed" = 'manual'
                                               OR i."createdAt" > f."generatedAt" + interval '1 hour'));
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 2 self-check failed: % indicator(s) with inconsistent provenance', n;
  END IF;
END
$$;

COMMIT;
