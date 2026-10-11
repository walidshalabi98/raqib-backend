#!/usr/bin/env bash
# Proves prisma/sql/2026-10-11_phase2_data_model.sql on throwaway local databases before it is run on a
# Supabase development branch or a shared database.
#
#   1. FRESH      create a database and `prisma db push` the Phase 2 schema.
#   2. SEED COPY  create a database with the schema at BASE_REV (022e09a, the schema shared databases have today),
#                 load the seed from that revision with a Prisma client generated from that schema, add a few
#                 edge-case fixtures, snapshot row counts and checksums of every existing column of every table,
#                 apply the SQL file with psql, then check: counts and checksums unchanged, every indicator linked
#                 to a result, results chain placeholders follow the hierarchy rule, primary sector in sectors,
#                 provenance, RLS on the new tables, the app's Prisma client can read the data, a second run is
#                 refused without changes, and `prisma migrate diff` reports no drift.
#   3. CLEANUP    drop the throwaway databases (set KEEP_DBS=1 to keep them for inspection).
#
# Usage:   scripts/verify-phase2-migration.sh
# Options (environment variables):
#   VERIFY_PG_BASE_URL  server to create the throwaway databases on, without a database name
#                       (default: the local CI Postgres, postgresql://raqib:raqib@localhost:5432)
#   BASE_REV            git revision whose schema and seed represent the current shared databases (default 022e09a)
#   KEEP_DBS=1          keep the databases at the end
#   VERIFY_ALLOW_NON_LOCAL=1  allow a server other than localhost (for example a CI service container)
#
# Needs: psql, git history containing BASE_REV, `npm ci` done, Postgres with pgvector. Never point it at a shared
# server: it only creates and drops databases whose names it generates (they always contain "test").

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_FILE="$ROOT/prisma/sql/2026-10-11_phase2_data_model.sql"
NEW_SCHEMA="$ROOT/prisma/schema.prisma"
BASE_REV="${BASE_REV:-022e09a}"
PG_BASE_URL="${VERIFY_PG_BASE_URL:-postgresql://raqib:raqib@localhost:5432}"
PG_BASE_URL="${PG_BASE_URL%/}"
KEEP_DBS="${KEEP_DBS:-0}"
PRISMA="$ROOT/node_modules/.bin/prisma"
TSX="$ROOT/node_modules/.bin/tsx"

RUN_ID="$(date +%s)_$$"
FRESH_DB="raqib_p2verify_fresh_${RUN_ID}_test"
SEED_DB="raqib_p2verify_seed_${RUN_ID}_test"
FRESH_URL="$PG_BASE_URL/$FRESH_DB"
SEED_URL="$PG_BASE_URL/$SEED_DB"
ADMIN_URL="$PG_BASE_URL/postgres"
# For messages: the server without its password.
SHOWN_URL="$(printf '%s' "$PG_BASE_URL" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#')"
PG_HOST="$(printf '%s' "$PG_BASE_URL" | sed -E 's#^[a-z]+://([^@/]*@)?(\[[^]]*\]|[^:/]*).*$#\2#')"

PASSES=0
FAILURES=0
CREATED_DBS=()
WORK=""

# --- output helpers ----------------------------------------------------------------------------------------------

section() { printf '\n=== %s ===\n' "$1"; }
info() { printf '  .. %s\n' "$1"; }
pass() { PASSES=$((PASSES + 1)); printf '  PASS  %s\n' "$1"; }
fail() { FAILURES=$((FAILURES + 1)); printf '  FAIL  %s\n' "$1"; }
die() { printf '\nFAIL  %s\n' "$1" >&2; exit 1; }

# Runs a command quietly; on failure prints its output and aborts.
run_quiet() {
  local label="$1"; shift
  local log
  log="$(mktemp "$WORK/log.XXXXXX")"
  if "$@" >"$log" 2>&1; then
    pass "$label"
  else
    fail "$label"
    sed 's/^/        /' "$log" | tail -n 40
    die "$label failed; stopping."
  fi
}

# Runs a command in a directory (portable replacement for env -C).
in_dir() { local dir="$1"; shift; (cd "$dir" && "$@"); }

# Single value from a query.
q() { psql "$1" -X -At -v ON_ERROR_STOP=1 -c "$2"; }

# Expects a query to return 0 (number of violations).
expect_zero() {
  local url="$1" label="$2" sql="$3" n
  n="$(q "$url" "$sql" 2>&1)" || { fail "$label (query error: $n)"; return 0; }
  if [[ "$n" == "0" ]]; then pass "$label"; else fail "$label (found $n)"; fi
}

# Expects a query to return a given value.
expect_eq() {
  local url="$1" label="$2" expected="$3" sql="$4" got
  got="$(q "$url" "$sql" 2>&1)" || { fail "$label (query error: $got)"; return 0; }
  if [[ "$got" == "$expected" ]]; then pass "$label"; else fail "$label (expected '$expected', got '$got')"; fi
}

create_db() {
  local name="$1"
  [[ "$name" == *test* ]] || die "refusing to create database '$name': its name must contain \"test\""
  psql "$ADMIN_URL" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$name\"" >/dev/null
  CREATED_DBS+=("$name")
}

cleanup() {
  local status=$?
  if [[ ${#CREATED_DBS[@]} -gt 0 ]]; then
    if [[ "$KEEP_DBS" == "1" ]]; then
      printf '\nKept databases: %s\n' "${CREATED_DBS[*]}"
    else
      for db in "${CREATED_DBS[@]}"; do
        [[ "$db" == *test* ]] || continue
        psql "$ADMIN_URL" -X -q -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1 \
          || printf 'warning: could not drop %s\n' "$db" >&2
      done
      printf '\nDropped throwaway databases: %s\n' "${CREATED_DBS[*]}"
    fi
  fi
  [[ -n "$WORK" && -d "$WORK" ]] && rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

# Prints the drift between a database and the Phase 2 schema; returns 0 when there is none.
check_no_drift() {
  local url="$1" label="$2" out code=0
  out="$(cd "$ROOT" && DATABASE_URL="$url" DIRECT_URL="$url" "$PRISMA" migrate diff \
    --from-url "$url" --to-schema-datamodel "$NEW_SCHEMA" --script --exit-code 2>&1)" || code=$?
  if [[ $code -eq 0 ]]; then
    pass "$label"
  else
    fail "$label (prisma migrate diff exit code $code)"
    printf '%s\n' "$out" | sed 's/^/        /' | tail -n 60
  fi
}

# --- preconditions -----------------------------------------------------------------------------------------------

section "Preconditions"
command -v psql >/dev/null || die "psql not found"
case "$PG_HOST" in
  localhost | 127.0.0.1 | "[::1]") ;;
  *) [[ "${VERIFY_ALLOW_NON_LOCAL:-0}" == "1" ]] \
       || die "refusing to use $SHOWN_URL: not localhost (set VERIFY_ALLOW_NON_LOCAL=1 for a throwaway server)" ;;
esac
[[ -x "$PRISMA" && -x "$TSX" ]] || die "node_modules missing: run npm ci first"
[[ -f "$SQL_FILE" ]] || die "missing $SQL_FILE"
git -C "$ROOT" cat-file -e "$BASE_REV:prisma/schema.prisma" 2>/dev/null \
  || die "git revision $BASE_REV not found (in CI use actions/checkout with fetch-depth: 0)"
psql "$ADMIN_URL" -X -At -c 'select 1' >/dev/null 2>&1 || die "cannot connect to $SHOWN_URL (is Postgres running?)"
mkdir -p "$ROOT/node_modules/.cache"
# Inside node_modules so the generated old client and the old seed resolve the repo's packages; ignored by lint/tsc.
WORK="$(mktemp -d "$ROOT/node_modules/.cache/verify-phase2.XXXXXX")"
pass "tools, base revision $BASE_REV and database server $SHOWN_URL available"

# --- 1. fresh database -------------------------------------------------------------------------------------------

section "1. Fresh database: prisma db push of the Phase 2 schema"
create_db "$FRESH_DB"
info "created $FRESH_DB"
run_quiet "prisma db push succeeds on an empty database" \
  in_dir "$ROOT" env DATABASE_URL="$FRESH_URL" DIRECT_URL="$FRESH_URL" "$PRISMA" db push --skip-generate
check_no_drift "$FRESH_URL" "no drift between the fresh database and prisma/schema.prisma"

# --- 2. copy of the current seed -----------------------------------------------------------------------------------

section "2. Copy of the current seed (schema and seed at $BASE_REV) upgraded with the SQL file"
create_db "$SEED_DB"
info "created $SEED_DB"

OLD="$WORK/old"
mkdir -p "$OLD"
git -C "$ROOT" show "$BASE_REV:prisma/schema.prisma" \
  | awk '{ print } /^[[:space:]]*provider[[:space:]]*=[[:space:]]*"prisma-client-js"/ { print "  output = \"./client\"" }' \
  >"$OLD/schema.prisma"
grep -q 'output = "./client"' "$OLD/schema.prisma" || die "could not point the old generator at a private output"
git -C "$ROOT" show "$BASE_REV:prisma/seed.ts" | sed "s|from '@prisma/client'|from './client'|" >"$OLD/seed.ts"
if grep -q "@prisma/client" "$OLD/seed.ts" || ! grep -q "from './client'" "$OLD/seed.ts"; then
  die "could not rewrite the old seed's Prisma import"
fi

# The old schema is pushed and generated from $OLD (no prisma.config.ts there), so the repo's client is untouched.
run_quiet "old schema pushed" \
  in_dir "$OLD" env DATABASE_URL="$SEED_URL" DIRECT_URL="$SEED_URL" "$PRISMA" db push --schema schema.prisma --skip-generate
run_quiet "old Prisma client generated into a private folder" \
  in_dir "$OLD" env DATABASE_URL="$SEED_URL" DIRECT_URL="$SEED_URL" "$PRISMA" generate --schema schema.prisma
run_quiet "old seed loaded (NODE_ENV=development)" \
  in_dir "$ROOT" env -u SEED_PASSWORD NODE_ENV=development DATABASE_URL="$SEED_URL" DIRECT_URL="$SEED_URL" "$TSX" "$OLD/seed.ts"

# Edge cases the seed does not cover: a manual framework with only output and activity indicators, a framework
# without aiModelUsed with outcome and activity indicators (gaps in the chain), an empty framework, and a
# beneficiary with a service so those tables are part of the checksums. All values are synthetic.
run_quiet "edge-case fixtures added" psql "$SEED_URL" -X -q -v ON_ERROR_STOP=1 -c "
  WITH p AS (SELECT id FROM \"Project\" ORDER BY \"createdAt\", id LIMIT 1)
  INSERT INTO \"Framework\" (id, \"projectId\", version, name, \"aiModelUsed\")
  SELECT x.id, p.id, x.v, x.name, x.model FROM p, (VALUES
    ('p2v-fw-manual', 2, 'Verify: manual, outputs and activities', 'manual'),
    ('p2v-fw-null',   3, 'Verify: no model, outcomes and activities', NULL),
    ('p2v-fw-empty',  4, 'Verify: empty framework', 'claude-sonnet-4-20250514')
  ) AS x(id, v, name, model);
  INSERT INTO \"Indicator\" (id, \"frameworkId\", \"indicatorText\", level, \"dataCollectionMethod\", frequency, phases, \"baselineValue\", \"targetValue\")
  VALUES
    ('p2v-ind-1', 'p2v-fw-manual', 'Number of people trained (fixture)', 'output', 'document_review', 'quarterly', '[\"baseline\",\"endline\"]', '0', '100'),
    ('p2v-ind-2', 'p2v-fw-manual', 'Number of training sessions held (fixture)', 'activity', 'document_review', 'monthly', '[]', NULL, '12'),
    ('p2v-ind-3', 'p2v-fw-manual', 'Number of kits distributed (fixture)', 'output', 'document_review', 'quarterly', '[]', NULL, NULL),
    ('p2v-ind-4', 'p2v-fw-null', '% of households with acceptable FCS (fixture)', 'outcome', 'hh_survey', 'baseline_endline', '[\"baseline\"]', '41%', NULL),
    ('p2v-ind-5', 'p2v-fw-null', 'Number of awareness sessions (fixture)', 'activity', 'document_review', 'monthly', '[]', NULL, NULL);
  INSERT INTO \"Beneficiary\" (id, \"projectId\", \"fullName\", gender, \"ageGroup\", governorate, \"updatedAt\")
  SELECT 'p2v-ben-1', id, 'Fixture Person', 'female', 'youth_18_24', 'Hebron', now() FROM \"Project\" ORDER BY \"createdAt\", id LIMIT 1;
  INSERT INTO \"BeneficiaryService\" (id, \"beneficiaryId\", \"projectId\", \"serviceType\", \"dateProvided\", quantity, unit, \"indicatorId\")
  SELECT 'p2v-svc-1', 'p2v-ben-1', \"projectId\", 'training', now(), 3, 'sessions', 'p2v-ind-1' FROM \"Beneficiary\" WHERE id = 'p2v-ben-1';
"

# Snapshot queries are built now, from the OLD columns, and reused after the migration.
SNAP_SQL="$WORK/snapshot.sql"
q "$SEED_URL" "
  SELECT format(
    'SELECT %L, count(*), md5(coalesce(string_agg(r, E''\\n'' ORDER BY r), '''')) FROM (SELECT ROW(%s)::text AS r FROM public.%I) s;',
    c.table_name, string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position), c.table_name)
  FROM information_schema.columns c
  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
  GROUP BY c.table_name ORDER BY c.table_name" >"$SNAP_SQL"
snapshot() { psql "$1" -X -At -F ' ' -v ON_ERROR_STOP=1 -f "$SNAP_SQL"; }
snapshot "$SEED_URL" >"$WORK/before.txt"
TABLES="$(wc -l <"$WORK/before.txt" | tr -d ' ')"
info "snapshot of $TABLES existing tables (row count + md5 of every existing column):"
awk '{ printf "        %-22s %6s rows  %s\n", $1, $2, $3 }' "$WORK/before.txt"

EXPECTED_NODES="$(q "$SEED_URL" 'SELECT count(*) FROM (SELECT DISTINCT "frameworkId", level FROM "Indicator") s')"

run_quiet "SQL file applied with psql -v ON_ERROR_STOP=1" \
  psql "$SEED_URL" -X -q -v ON_ERROR_STOP=1 -f "$SQL_FILE"

section "2b. Checks after the migration"
snapshot "$SEED_URL" >"$WORK/after.txt"
if diff -u "$WORK/before.txt" "$WORK/after.txt" >"$WORK/snapshot.diff"; then
  pass "row counts and checksums unchanged for all $TABLES pre-existing tables"
else
  fail "row counts or checksums changed:"
  sed 's/^/        /' "$WORK/snapshot.diff"
fi

S="$SEED_URL"
LEVEL_ABOVE="CASE c.level WHEN 'outcome' THEN 'impact' WHEN 'output' THEN 'outcome' WHEN 'activity' THEN 'output' END"

expect_zero "$S" "every indicator has a resultId" \
  'SELECT count(*) FROM "Indicator" WHERE "resultId" IS NULL'
expect_zero "$S" "each indicator's result is in its framework and at its level" \
  'SELECT count(*) FROM "Indicator" i JOIN "ResultNode" r ON r.id = i."resultId" WHERE r."frameworkId" <> i."frameworkId" OR r.level <> i.level'
expect_eq "$S" "one placeholder per framework and level in use ($EXPECTED_NODES)" "$EXPECTED_NODES" \
  'SELECT count(*) FROM "ResultNode"'
expect_zero "$S" "no duplicate placeholders" \
  'SELECT count(*) FROM (SELECT 1 FROM "ResultNode" GROUP BY "frameworkId", level HAVING count(*) > 1) d'
expect_zero "$S" "placeholder codes Goal/O/OP/A, English and Arabic text, sortOrder 0" \
  "SELECT count(*) FROM \"ResultNode\" WHERE code <> CASE level WHEN 'impact' THEN 'Goal' WHEN 'outcome' THEN 'O' WHEN 'output' THEN 'OP' ELSE 'A' END
     OR text NOT LIKE '% indicators (results chain to be completed)' OR coalesce(\"textAr\", '') !~ '[ء-ي]' OR \"sortOrder\" <> 0"
expect_zero "$S" "hierarchy rule: impact has no parent; a parent is one level up in the same framework" \
  "SELECT count(*) FROM \"ResultNode\" c LEFT JOIN \"ResultNode\" p ON p.id = c.\"parentId\"
   WHERE (c.level = 'impact' AND c.\"parentId\" IS NOT NULL)
      OR (c.\"parentId\" IS NOT NULL AND (p.\"frameworkId\" <> c.\"frameworkId\" OR p.level::text IS DISTINCT FROM $LEVEL_ABOVE))"
expect_zero "$S" "chained: a placeholder has the parent one level up whenever that placeholder exists" \
  "SELECT count(*) FROM \"ResultNode\" c WHERE c.level <> 'impact' AND c.\"parentId\" IS NULL
     AND EXISTS (SELECT 1 FROM \"ResultNode\" p WHERE p.\"frameworkId\" = c.\"frameworkId\" AND p.level::text = $LEVEL_ABOVE)"
expect_eq "$S" "seed framework: full chain Goal <- O <- OP <- A" "Goal>O>OP>A" \
  "SELECT string_agg(c.code, '>' ORDER BY c.level) FROM \"ResultNode\" c JOIN \"Framework\" f ON f.id = c.\"frameworkId\"
   WHERE f.id = (SELECT \"frameworkId\" FROM \"Indicator\" WHERE \"frameworkId\" NOT LIKE 'p2v-%' LIMIT 1)
     AND (c.level = 'impact' OR c.\"parentId\" IS NOT NULL)"
expect_eq "$S" "manual fixture: output has no parent (no outcome), activity's parent is the output" "OP:-,A:OP" \
  "SELECT string_agg(c.code || ':' || coalesce(p.code, '-'), ',' ORDER BY c.level) FROM \"ResultNode\" c
   LEFT JOIN \"ResultNode\" p ON p.id = c.\"parentId\" WHERE c.\"frameworkId\" = 'p2v-fw-manual'"
expect_eq "$S" "no-model fixture: outcome and activity have no parent (gaps in the chain)" "O:-,A:-" \
  "SELECT string_agg(c.code || ':' || coalesce(p.code, '-'), ',' ORDER BY c.level) FROM \"ResultNode\" c
   LEFT JOIN \"ResultNode\" p ON p.id = c.\"parentId\" WHERE c.\"frameworkId\" = 'p2v-fw-null'"
expect_zero "$S" "empty framework gets no placeholder" \
  "SELECT count(*) FROM \"ResultNode\" WHERE \"frameworkId\" = 'p2v-fw-empty'"
expect_zero "$S" "every project has its primary sector in sectors (and only it)" \
  'SELECT count(*) FROM "Project" WHERE "sectors" IS NULL OR NOT ("sector" = ANY ("sectors")) OR cardinality("sectors") <> 1'
expect_zero "$S" "existing projects are not marked humanitarian" \
  'SELECT count(*) FROM "Project" WHERE humanitarian'
expect_zero "$S" "provenance: manual when aiModelUsed is NULL or 'manual', else ai_generated with aiModel" \
  "SELECT count(*) FROM \"Indicator\" i JOIN \"Framework\" f ON f.id = i.\"frameworkId\"
   WHERE ((f.\"aiModelUsed\" IS NULL OR f.\"aiModelUsed\" = 'manual') AND (i.provenance <> 'manual' OR i.\"aiModel\" IS NOT NULL))
      OR ((f.\"aiModelUsed\" IS NOT NULL AND f.\"aiModelUsed\" <> 'manual') AND (i.provenance <> 'ai_generated' OR i.\"aiModel\" IS DISTINCT FROM f.\"aiModelUsed\"))"
expect_eq "$S" "both provenance branches exercised (manual, ai_generated)" "ai_generated,manual" \
  "SELECT string_agg(DISTINCT provenance::text, ',' ORDER BY provenance::text) FROM \"Indicator\""
expect_zero "$S" "no reference-sheet values invented for existing indicators" \
  'SELECT count(*) FROM "Indicator" WHERE coalesce(definition, "meansOfVerification", "baselineMethod", "targetJustification", assumptions, "libraryId", "standardReferenceCode", "promptVersion") IS NOT NULL
     OR calculation IS NOT NULL OR direction IS NOT NULL OR disaggregation IS NOT NULL OR "baselineDate" IS NOT NULL OR "intermediateTargets" IS NOT NULL'
expect_zero "$S" "no breakdown invented for existing data points" \
  'SELECT count(*) FROM "DataPoint" WHERE breakdown IS NOT NULL'
expect_eq "$S" "row level security enabled on ResultNode and IndicatorLibraryEntry" "2" \
  "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('ResultNode', 'IndicatorLibraryEntry') AND relrowsecurity"
expect_eq "$S" "new enum values present (Sector, DonorType)" "9" \
  "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE (t.typname = 'Sector' AND e.enumlabel IN ('mhpss', 'cash', 'shelter', 'climate_energy'))
      OR (t.typname = 'DonorType' AND e.enumlabel IN ('echo', 'wfp', 'unfpa', 'fcdo', 'un_women'))"
expect_eq "$S" "legacy usaid donor type and METemplate table kept" "1|true" \
  "SELECT count(*) || '|' || (to_regclass('public.\"METemplate\"') IS NOT NULL) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'DonorType' AND e.enumlabel = 'usaid'"
check_no_drift "$S" "no drift between the migrated database and prisma/schema.prisma"

# The app's Prisma client (generated from the Phase 2 schema) can read the migrated data.
cat >"$WORK/read-check.ts" <<'TS'
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const indicators = await prisma.indicator.findMany({ include: { result: { include: { parent: true } } } });
    const projects = await prisma.project.findMany({ select: { sector: true, sectors: true, humanitarian: true } });
    const nodes = await prisma.resultNode.findMany({ include: { _count: { select: { indicators: true, children: true } } } });
    const unlinked = indicators.filter((i) => !i.result).length;
    const badSectors = projects.filter((p) => !p.sectors.includes(p.sector)).length;
    console.log(JSON.stringify({ indicators: indicators.length, unlinked, projects: projects.length, badSectors, nodes: nodes.length }));
    if (unlinked > 0 || badSectors > 0 || nodes.length === 0) process.exit(2);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
TS
run_quiet "the app's Prisma client reads indicators with results, projects with sectors, result nodes" \
  in_dir "$ROOT" env DATABASE_URL="$SEED_URL" DIRECT_URL="$SEED_URL" "$TSX" "$WORK/read-check.ts"

# Running the file a second time must be refused and change nothing.
NODES_SQL="SELECT count(*) || ' ' || md5(coalesce(string_agg(id || ':' || \"frameworkId\" || ':' || coalesce(\"parentId\", '') || ':' || code, ',' ORDER BY id), '')) FROM \"ResultNode\""
snapshot "$SEED_URL" >"$WORK/after1.txt"
q "$S" "$NODES_SQL" >"$WORK/nodes1.txt"
if psql "$SEED_URL" -X -q -v ON_ERROR_STOP=1 -f "$SQL_FILE" >"$WORK/rerun.log" 2>&1; then
  fail "second run was not refused"
elif grep -q "already applied" "$WORK/rerun.log"; then
  snapshot "$SEED_URL" >"$WORK/after2.txt"
  q "$S" "$NODES_SQL" >"$WORK/nodes2.txt"
  if cmp -s "$WORK/after1.txt" "$WORK/after2.txt" && cmp -s "$WORK/nodes1.txt" "$WORK/nodes2.txt"; then
    pass "second run refused (\"already applied\") and nothing changed"
  else
    fail "second run was refused but data changed"
  fi
else
  fail "second run failed for an unexpected reason:"
  sed 's/^/        /' "$WORK/rerun.log" | tail -n 20
fi

info "after the migration: $(q "$S" 'SELECT count(*) FROM "ResultNode"') result nodes, $(q "$S" 'SELECT count(*) FROM "Indicator"') indicators linked, $(q "$S" 'SELECT count(*) FROM "Project"') projects, IndicatorLibraryEntry rows: $(q "$S" 'SELECT count(*) FROM "IndicatorLibraryEntry"') (filled later by npm run seed:library)"

# --- summary -----------------------------------------------------------------------------------------------------

section "Summary"
if [[ $FAILURES -eq 0 ]]; then
  printf 'PASS  %d checks passed, 0 failed\n' "$PASSES"
else
  printf 'FAIL  %d checks passed, %d failed\n' "$PASSES" "$FAILURES"
  exit 1
fi
