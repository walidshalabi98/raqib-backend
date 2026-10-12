-- Phase 3: AI foundation. Adds the AiCall table (one row per AI model call: model, prompt versions, tokens, latency,
-- estimated cost; never prompts, model output or personal data), Document.aiAnalysis (the model's analysis of a
-- document, kept apart from the document's own text), Document.qualitativeSource (an FGD/KII transcript uploaded
-- through the qualitative upload, never used by document AI features), Framework.generationError (a version whose AI
-- generation failed; never the project's current framework) and IndicatorLibraryEntry.embeddingModel (the model that
-- made the stored vector). It moves the analysis that the old document parser appended to parsedText into aiAnalysis,
-- and marks the transcripts that the old qualitative upload stored as documents.
--
-- Order: apply AFTER prisma/sql/2026-10-11_phase0_webhook_tokens.sql and prisma/sql/2026-10-11_phase2_data_model.sql.
-- Upgrades a database that matches prisma/schema.prisma at commit 642c474 (Phase 2) to the Phase 3 schema; the guard
-- below refuses to run (and changes nothing) when Phase 0 or Phase 2 is missing or Phase 3 is already applied.
-- Additive only: no table or column is dropped or renamed. The only existing values that change are the parsedText of
-- documents that contain the legacy marker '---AI_ANALYSIS---' (section 3); nothing is lost, the part after the LAST
-- marker moves to aiAnalysis. New columns start empty (generationError, embeddingModel) or false (qualitativeSource,
-- set to true only for documents attached to a qualitative entry of their own project).
--
-- DDL generated with (unchanged, section 2):
--   prisma migrate diff --from-schema-datamodel <schema at 642c474> --to-schema-datamodel prisma/schema.prisma --script
-- Everything runs in one transaction: the guard, the generated DDL, the data moves, row level security on the new
-- table and a self-check that rolls everything back if it fails. scripts/verify-migrations.sh checks that
-- `prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma` reports no drift afterwards.
--
-- Locks: the ALTER TABLE statements take ACCESS EXCLUSIVE locks on Document, Framework and IndicatorLibraryEntry, and
-- the foreign keys lock Organization and Project, until COMMIT (seconds at current volumes; the data move reads every
-- document's parsedText under the lock). lock_timeout makes a busy table fail the run fast (nothing changes) instead
-- of queueing every other query behind it; run the file again in a quieter moment.
--
-- How to run (see docs/DATA_MODEL.md): on a Supabase development branch first, then on the shared database:
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/2026-10-12_phase3_ai_foundation.sql
-- Do not add --single-transaction (the file manages its own transaction).
-- Proven locally on a fresh database and on a copy of the seed (after the Phase 2 SQL), with pgvector in public and in
-- an `extensions` schema as on Supabase, by scripts/verify-migrations.sh.

BEGIN;

-- Give up after 5 seconds of waiting for a lock (the whole transaction is rolled back). Reverts at COMMIT/ROLLBACK.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Guard: refuse to run twice or out of order (the transaction is rolled back and nothing changes)
-- ---------------------------------------------------------------------------------------------------------------

DO $$
DECLARE
  leftovers text;
BEGIN
  IF to_regclass('public."AiCall"') IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 3 migration already applied: table "AiCall" exists. Nothing was changed.';
  END IF;
  -- Anything else this file creates, left over from a half-done attempt (e.g. a partial `prisma db push`).
  SELECT string_agg(s.what, ', ' ORDER BY s.what) INTO leftovers
  FROM (
    SELECT 'type "AiCallStatus"' AS what WHERE to_regtype('public."AiCallStatus"') IS NOT NULL
    UNION ALL
    SELECT format('column %I.%I', c.table_name, c.column_name)
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name::text || '.' || c.column_name::text IN
          ('Document.aiAnalysis', 'Document.qualitativeSource', 'Framework.generationError', 'IndicatorLibraryEntry.embeddingModel')
  ) s;
  IF leftovers IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 3 migration already partly applied: % exist(s) without table "AiCall". Nothing was changed; compare the database with prisma/schema.prisma first.', leftovers;
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
ALTER TABLE "Document" ADD COLUMN     "aiAnalysis" JSONB,
ADD COLUMN     "qualitativeSource" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Framework" ADD COLUMN     "generationError" TEXT;

-- AlterTable
ALTER TABLE "IndicatorLibraryEntry" ADD COLUMN     "embeddingModel" TEXT;

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

-- CreateIndex
CREATE INDEX "AiCall_projectId_createdAt_idx" ON "AiCall"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiCall" ADD CONSTRAINT "AiCall_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCall" ADD CONSTRAINT "AiCall_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Data moves: legacy AI analyses leave parsedText; legacy transcripts are marked
-- ---------------------------------------------------------------------------------------------------------------

-- The old parser stored `<document text>\n\n---AI_ANALYSIS---\n<model answer>` in parsedText: one marker, appended at
-- the end. For every document whose parsedText contains the marker (strpos, not LIKE: "_" is a LIKE wildcard), split
-- at the LAST marker, as the application's readers do (stripAiAnalysis, the assessment generator and the frontend use
-- lastIndexOf), so a marker that the document's own text quotes stays in parsedText with the rest of that text:
--   * parsedText = the text before the last marker, trailing whitespace (the separator) trimmed;
--   * aiAnalysis = the text after it parsed as JSON when it is a JSON object that jsonb stores without loss (no
--     duplicate keys at any depth); otherwise {"legacyText": <the text after the marker, whitespace trimmed>} (also
--     when the check cannot finish, e.g. an object nested too deeply for the stack); NULL when nothing but whitespace
--     follows the marker.
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

-- For the self-check: the number of values in a JSON document at every depth (the document itself included). A
-- recursive query, not recursive PL/pgSQL, so any depth works, and independent of raqib_phase3_has_duplicate_keys. json
-- keeps a repeated key and jsonb keeps only the last one, so a JSON text and the jsonb stored from it have the same
-- count only when jsonb dropped nothing.
CREATE FUNCTION pg_temp.raqib_phase3_json_values(j json) RETURNS bigint
LANGUAGE sql AS $$
  WITH RECURSIVE w(v) AS (
    SELECT j
    UNION ALL
    SELECT c.v
    FROM w
    CROSS JOIN LATERAL (
      SELECT e.value AS v FROM json_each(CASE WHEN json_typeof(w.v) = 'object' THEN w.v ELSE '{}'::json END) AS e
      UNION ALL
      SELECT a.value FROM json_array_elements(CASE WHEN json_typeof(w.v) = 'array' THEN w.v ELSE '[]'::json END) AS a
    ) c
  )
  SELECT count(*) FROM w
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
    -- Any error in the check (e.g. "stack depth limit exceeded" for an object nested hundreds of levels deep, which
    -- jsonb accepts but the recursive check cannot walk) keeps the text verbatim instead of aborting the migration.
    BEGIN
      IF NOT pg_temp.raqib_phase3_has_duplicate_keys(body::json) THEN
        RETURN parsed;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('legacyText', body);
    END;
  END IF;
  RETURN jsonb_build_object('legacyText', body);
END
$$;

-- The legacy rows as they were, for the self-check (session-local; gone when the session ends). "markerAt" is where
-- the LAST marker starts: the first match in the reversed text, mapped back (length - position - marker length + 2).
CREATE TEMP TABLE raqib_phase3_legacy_documents AS
SELECT "id", "parsedText" AS "before",
       length("parsedText") - strpos(reverse("parsedText"), reverse('---AI_ANALYSIS---')) - length('---AI_ANALYSIS---') + 2
         AS "markerAt"
FROM "Document"
WHERE strpos("parsedText", '---AI_ANALYSIS---') > 0;

UPDATE "Document" d
SET "aiAnalysis" = pg_temp.raqib_phase3_legacy_analysis(substr(l."before", l."markerAt" + length('---AI_ANALYSIS---'))),
    "parsedText" = rtrim(left(l."before", l."markerAt" - 1), E' \t\r\n\f\x0B')
FROM raqib_phase3_legacy_documents l
WHERE d."id" = l."id";

-- Transcripts that the old qualitative upload stored as documents: POST /api/projects/:id/qualitative/upload created a
-- Document and then a QualitativeEntry with attachments [{"documentId": <id>, "fileName": <name>}]. Mark them
-- qualitativeSource, as the Phase 3 upload does, so FGD/KII transcripts are never sent to document analysis, framework
-- generation or assessment summaries. Only a document attached to an entry of its own project counts; attachments
-- that are not an array of objects are ignored. (A transcript whose parsing failed got no entry; it cannot be told
-- apart from other documents and stays false.)
UPDATE "Document" d
SET "qualitativeSource" = true
WHERE EXISTS (
  SELECT 1
  FROM "QualitativeEntry" q
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(q."attachments") = 'array' THEN q."attachments" ELSE '[]'::jsonb END) AS a(item)
  WHERE q."projectId" = d."projectId" AND jsonb_typeof(a.item) = 'object' AND a.item -> 'documentId' = to_jsonb(d."id")
);

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
  WHERE table_schema = 'public'
    AND ((table_name = 'Document' AND column_name = 'aiAnalysis' AND data_type = 'jsonb')
      OR (table_name = 'Document' AND column_name = 'qualitativeSource' AND data_type = 'boolean' AND is_nullable = 'NO')
      OR (table_name = 'Framework' AND column_name = 'generationError' AND data_type = 'text')
      OR (table_name = 'IndicatorLibraryEntry' AND column_name = 'embeddingModel' AND data_type = 'text'));
  IF n <> 4 THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: only % of the 4 new columns (Document.aiAnalysis, Document.qualitativeSource, Framework.generationError, IndicatorLibraryEntry.embeddingModel) are in place', n;
  END IF;

  SELECT count(*) INTO n FROM pg_class
  WHERE oid = 'public."AiCall"'::regclass AND relrowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: row level security is not enabled on "AiCall"';
  END IF;

  -- No value invented for the new text columns.
  SELECT (SELECT count(*) FROM "Framework" WHERE "generationError" IS NOT NULL)
       + (SELECT count(*) FROM "IndicatorLibraryEntry" WHERE "embeddingModel" IS NOT NULL) INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: % row(s) got a generationError or embeddingModel', n;
  END IF;

  -- The split point is the LAST marker, checked without the reverse() arithmetic used above: a marker starts there
  -- and none starts after it.
  SELECT count(*) INTO n FROM raqib_phase3_legacy_documents l
  WHERE l."markerAt" IS NULL
     OR substr(l."before", l."markerAt", length('---AI_ANALYSIS---')) IS DISTINCT FROM '---AI_ANALYSIS---'
     OR strpos(substr(l."before", l."markerAt" + 1), '---AI_ANALYSIS---') > 0;
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: % legacy document(s) not split at the last ---AI_ANALYSIS--- marker', n;
  END IF;

  -- A marker can stay in parsedText only as part of a moved document's own text (quoted before its last marker).
  SELECT count(*) INTO n FROM "Document" d
  WHERE strpos(d."parsedText", '---AI_ANALYSIS---') > 0
    AND NOT EXISTS (SELECT 1 FROM raqib_phase3_legacy_documents l WHERE l."id" = d."id");
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: % document(s) that were not moved contain the ---AI_ANALYSIS--- marker', n;
  END IF;

  -- Only the legacy rows got an analysis.
  SELECT count(*) INTO n FROM "Document" d
  WHERE d."aiAnalysis" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM raqib_phase3_legacy_documents l WHERE l."id" = d."id");
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: % document(s) without the marker got an aiAnalysis', n;
  END IF;

  -- Nothing lost: parsedText is the text before the last marker (only trailing whitespace trimmed), and aiAnalysis
  -- holds the text after it (verbatim as legacyText, or as the same JSON object), or the text after it was only
  -- whitespace. For an object, the number of values at every depth must match too, counted independently of the
  -- duplicate-key helper: json keeps a repeated key and jsonb does not, so a dropped value shows up here.
  SELECT count(*) INTO n
  FROM raqib_phase3_legacy_documents l
  JOIN "Document" d ON d."id" = l."id"
  CROSS JOIN LATERAL (SELECT btrim(substr(l."before", l."markerAt" + length('---AI_ANALYSIS---')), E' \t\r\n\f\x0B') AS body) t
  WHERE d."parsedText" IS DISTINCT FROM rtrim(left(l."before", l."markerAt" - 1), E' \t\r\n\f\x0B')
     OR (CASE
           WHEN t.body = '' THEN d."aiAnalysis" IS NULL
           WHEN d."aiAnalysis" IS NULL THEN false
           WHEN d."aiAnalysis" = jsonb_build_object('legacyText', t.body) THEN true
           WHEN jsonb_typeof(d."aiAnalysis") = 'object' AND d."aiAnalysis" = pg_temp.raqib_phase3_try_jsonb(t.body)
             THEN pg_temp.raqib_phase3_json_values(t.body::json) = pg_temp.raqib_phase3_json_values(d."aiAnalysis"::json)
           ELSE false
         END) IS NOT TRUE;
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: % legacy document(s) not moved exactly', n;
  END IF;

  -- Transcripts: exactly the documents attached to a qualitative entry of their own project are marked (checked with
  -- jsonb containment, independently of the UPDATE above).
  SELECT count(*) INTO n FROM "Document" d
  WHERE d."qualitativeSource" IS DISTINCT FROM EXISTS (
    SELECT 1 FROM "QualitativeEntry" q
    WHERE q."projectId" = d."projectId" AND jsonb_typeof(q."attachments") = 'array'
      AND q."attachments" @> jsonb_build_array(jsonb_build_object('documentId', d."id")));
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 3 self-check failed: % document(s) with a wrong qualitativeSource', n;
  END IF;
END
$$;

COMMIT;
