-- Phase 3: AI foundation. Adds the AiCall table (one row per AI model call: model, prompt versions, tokens, latency,
-- estimated cost; never prompts, model output or personal data) and Document.aiAnalysis (the model's analysis of a
-- document, kept apart from the document's own text), and moves the analysis that the old document parser appended to
-- parsedText into the new column.
--
-- Order: apply AFTER prisma/sql/2026-10-11_phase0_webhook_tokens.sql and prisma/sql/2026-10-11_phase2_data_model.sql.
-- Upgrades a database that matches prisma/schema.prisma at commit 642c474 (Phase 2) to the Phase 3 schema; the guard
-- below refuses to run (and changes nothing) when Phase 0 or Phase 2 is missing or Phase 3 is already applied.
-- Additive only: no table or column is dropped or renamed. The only existing values that change are the parsedText of
-- documents that contain the legacy marker '---AI_ANALYSIS---' (section 3); nothing is lost, the part after the
-- marker moves to aiAnalysis.
--
-- DDL generated with (unchanged, section 2):
--   prisma migrate diff --from-schema-datamodel <schema at 642c474> --to-schema-datamodel prisma/schema.prisma --script
-- Everything runs in one transaction: the guard, the generated DDL, the data move, row level security on the new table
-- and a self-check that rolls everything back if it fails. scripts/verify-migrations.sh checks that
-- `prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma` reports no drift afterwards.
--
-- How to run (see docs/DATA_MODEL.md): on a Supabase development branch first, then on the shared database:
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/2026-10-12_phase3_ai_foundation.sql
-- Do not add --single-transaction (the file manages its own transaction).
-- Proven locally on a fresh database and on a copy of the seed (after the Phase 2 SQL) by scripts/verify-migrations.sh.

BEGIN;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Guard: refuse to run twice or out of order (the transaction is rolled back and nothing changes)
-- ---------------------------------------------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public."AiCall"') IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 3 migration already applied: table "AiCall" exists. Nothing was changed.';
  END IF;
  IF to_regtype('public."AiCallStatus"') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'Document' AND column_name = 'aiAnalysis') THEN
    RAISE EXCEPTION 'Phase 3 migration already partly applied: type "AiCallStatus" or column "Document"."aiAnalysis" exists without table "AiCall". Nothing was changed; compare the database with prisma/schema.prisma first.';
  END IF;
  IF to_regclass('public."WebhookToken"') IS NULL THEN
    RAISE EXCEPTION 'Phase 3 migration needs the Phase 0 SQL first (prisma/sql/2026-10-11_phase0_webhook_tokens.sql): table "WebhookToken" is missing. Nothing was changed.';
  END IF;
  IF to_regclass('public."ResultNode"') IS NULL THEN
    RAISE EXCEPTION 'Phase 3 migration needs the Phase 2 SQL first (prisma/sql/2026-10-11_phase2_data_model.sql): table "ResultNode" is missing. Nothing was changed.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Generated DDL
-- ---------------------------------------------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "AiCallStatus" AS ENUM ('success', 'refusal', 'max_tokens', 'invalid_output', 'error');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "aiAnalysis" JSONB;

-- CreateTable
CREATE TABLE "AiCall" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "servedModel" TEXT,
    "promptVersion" TEXT NOT NULL,
    "systemPromptVersion" TEXT,
    "status" "AiCallStatus" NOT NULL,
    "stopReason" TEXT,
    "errorType" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "estimatedCostUsd" DECIMAL(12,6),
    "organizationId" TEXT,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiCall_createdAt_idx" ON "AiCall"("createdAt");

-- CreateIndex
CREATE INDEX "AiCall_organizationId_createdAt_idx" ON "AiCall"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCall_feature_createdAt_idx" ON "AiCall"("feature", "createdAt");

-- AddForeignKey
ALTER TABLE "AiCall" ADD CONSTRAINT "AiCall_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCall" ADD CONSTRAINT "AiCall_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Data move: the legacy AI analysis leaves parsedText
-- ---------------------------------------------------------------------------------------------------------------

-- The old parser stored `<document text>\n\n---AI_ANALYSIS---\n<model answer>` in parsedText. For every document whose
-- parsedText contains the marker (strpos, not LIKE: "_" is a LIKE wildcard), split at the FIRST marker, as the
-- application's readers do (so no marker can remain in parsedText):
--   * parsedText = the text before the marker, trailing whitespace (the separator) trimmed;
--   * aiAnalysis = the text after the marker parsed as JSON when it is a JSON object that jsonb stores without loss
--     (no duplicate keys at any depth); otherwise {"legacyText": <the text after the marker, whitespace trimmed>};
--     NULL when nothing but whitespace follows the marker.
-- Legacy objects keep their original keys (snake_case such as indicators_mentioned, targets_mentioned); readers accept
-- them. The text is moved as stored: phone numbers, ID numbers and email addresses in rows parsed before Phase 3 are
-- removed by the application before any AI use, and by the parser when a document is parsed again.
-- The helpers live in pg_temp (gone when the session ends); they must be called schema-qualified.

-- True when a JSON value has an object with the same key twice at any depth (jsonb would keep only the last one).
CREATE FUNCTION pg_temp.raqib_phase3_has_duplicate_keys(j json) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v json;
BEGIN
  IF json_typeof(j) = 'object' THEN
    IF (SELECT count(*) <> count(DISTINCT k) FROM json_object_keys(j) AS k) THEN
      RETURN true;
    END IF;
    FOR v IN SELECT e.value FROM json_each(j) AS e LOOP
      IF pg_temp.raqib_phase3_has_duplicate_keys(v) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF json_typeof(j) = 'array' THEN
    FOR v IN SELECT e FROM json_array_elements(j) AS e LOOP
      IF pg_temp.raqib_phase3_has_duplicate_keys(v) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END
$$;

-- The text as jsonb; NULL when it is not valid JSON (e.g. an answer cut off at max_tokens) or jsonb cannot store it
-- (e.g. \u0000).
CREATE FUNCTION pg_temp.raqib_phase3_try_jsonb(body text) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  RETURN body::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

-- The value for aiAnalysis from the text after the marker (see above).
CREATE FUNCTION pg_temp.raqib_phase3_legacy_analysis(tail text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  body text := btrim(tail, E' \t\r\n\f\x0B');
  parsed jsonb;
BEGIN
  IF body = '' THEN
    RETURN NULL;
  END IF;
  parsed := pg_temp.raqib_phase3_try_jsonb(body);
  -- Nested, not AND: with parsed NULL, `NULL AND x` still evaluates x, and body::json would fail on invalid JSON.
  IF jsonb_typeof(parsed) = 'object' THEN
    IF NOT pg_temp.raqib_phase3_has_duplicate_keys(body::json) THEN
      RETURN parsed;
    END IF;
  END IF;
  RETURN jsonb_build_object('legacyText', body);
END
$$;

-- The legacy rows as they were, for the self-check (session-local; gone when the session ends).
CREATE TEMP TABLE raqib_phase3_legacy_documents AS
SELECT "id", "parsedText" AS "before", strpos("parsedText", '---AI_ANALYSIS---') AS "markerAt"
FROM "Document"
WHERE strpos("parsedText", '---AI_ANALYSIS---') > 0;

UPDATE "Document" d
SET "aiAnalysis" = pg_temp.raqib_phase3_legacy_analysis(substr(l."before", l."markerAt" + length('---AI_ANALYSIS---'))),
    "parsedText" = rtrim(left(l."before", l."markerAt" - 1), E' \t\r\n\f\x0B')
FROM raqib_phase3_legacy_documents l
WHERE d."id" = l."id";

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------------------------------------------------

-- As for Phase 2's new tables: Supabase exposes the public schema through its Data API, so enable RLS (with no
-- policies) on the new table and it is never readable or writable with the anon key. Prisma connects as the table
-- owner and is unaffected.
ALTER TABLE "AiCall" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Self-check: any failure rolls back the whole transaction
-- ---------------------------------------------------------------------------------------------------------------

DO $$
DECLARE
  n integer;
BEGIN
  IF to_regclass('public."AiCall"') IS NULL THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: table "AiCall" is missing';
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'Document' AND column_name = 'aiAnalysis' AND data_type = 'jsonb';
  IF n <> 1 THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: column "Document"."aiAnalysis" (jsonb) is missing';
  END IF;

  SELECT count(*) INTO n FROM pg_class
  WHERE oid = 'public."AiCall"'::regclass AND relrowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: row level security is not enabled on "AiCall"';
  END IF;

  SELECT count(*) INTO n FROM "Document" WHERE strpos("parsedText", '---AI_ANALYSIS---') > 0;
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: % document(s) still contain the ---AI_ANALYSIS--- marker', n;
  END IF;

  -- Only the legacy rows got an analysis.
  SELECT count(*) INTO n FROM "Document" d
  WHERE d."aiAnalysis" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM raqib_phase3_legacy_documents l WHERE l."id" = d."id");
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: % document(s) without the marker got an aiAnalysis', n;
  END IF;

  -- Nothing lost: parsedText is the text before the marker (only trailing whitespace trimmed), and aiAnalysis holds the
  -- text after it (as the same JSON value, or verbatim as legacyText), or the text after it was only whitespace.
  SELECT count(*) INTO n
  FROM raqib_phase3_legacy_documents l
  JOIN "Document" d ON d."id" = l."id"
  CROSS JOIN LATERAL (SELECT btrim(substr(l."before", l."markerAt" + length('---AI_ANALYSIS---')), E' \t\r\n\f\x0B') AS body) t
  WHERE d."parsedText" IS DISTINCT FROM rtrim(left(l."before", l."markerAt" - 1), E' \t\r\n\f\x0B')
     OR (CASE
           WHEN t.body = '' THEN d."aiAnalysis" IS NULL
           WHEN d."aiAnalysis" IS NULL THEN false
           WHEN d."aiAnalysis" = jsonb_build_object('legacyText', t.body) THEN true
           ELSE jsonb_typeof(d."aiAnalysis") = 'object' AND d."aiAnalysis" = pg_temp.raqib_phase3_try_jsonb(t.body)
         END) IS NOT TRUE;
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: % legacy document(s) not moved exactly', n;
  END IF;
END
$$;

COMMIT;
