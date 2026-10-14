#!/usr/bin/env bash
# Proves the reviewed SQL files on throwaway local databases before they are run on a Supabase development branch or a
# shared database, in rollout order:
#   prisma/sql/2026-10-11_phase0_webhook_tokens.sql (Phase 0: WebhookToken; already part of the BASE_REV schema)
#   prisma/sql/2026-10-11_phase2_data_model.sql     (Phase 2: results chain, reference sheet, library)
#   prisma/sql/2026-10-12_phase3_ai_foundation.sql  (Phase 3: AiCall, Document.aiAnalysis and qualitativeSource,
#                                                    Framework.generationError, IndicatorLibraryEntry.embeddingModel)
#   prisma/sql/2026-10-12_phase4_kpi_assistant.sql  (Phase 4: KpiSuggestionRun, KpiSuggestion and their four enums)
#
#   0. STATIC     no file contains a DROP statement; the Phase 3 and Phase 4 files are each one transaction that sets
#                 lock_timeout first.
#   1. FRESH      create a database and `prisma db push` the current schema: no drift, the Phase 3 and Phase 4 SQL are
#                 refused there ("already applied") without changes, and the app's Prisma client creates and reads
#                 AiCall rows and KPI runs and suggestions.
#   2. EMPTY      the Phase 3 SQL on a database without the Phase 0 schema is refused and creates nothing; with a
#                 leftover AiCallStatus type it is refused as "already partly applied". The Phase 4 SQL there is refused
#                 ("needs the Phase 3 SQL first") and creates nothing; with a leftover SuggestionStatus type it is
#                 refused as "already partly applied".
#   2b. PARTIAL   on copies of a database at the Phase 2 schema, each column the Phase 3 SQL adds, left over alone
#                 (e.g. Document.aiAnalysis without AiCall), makes it refuse as "already partly applied", unchanged; on
#                 copies of a database at the Phase 3 schema, each type or the run table the Phase 4 SQL creates, left
#                 over alone, makes the Phase 4 SQL refuse the same way, unchanged.
#   3. SEED COPY  create a database with the schema at BASE_REV (022e09a: today's shared schema plus the Phase 0 SQL),
#                 load the seed from that revision with a Prisma client generated from that schema, add edge-case
#                 fixtures (frameworks, indicators, a beneficiary, legacy documents, qualitative entries), snapshot row
#                 counts and checksums of every column of every table, check that the Phase 3 SQL is refused before
#                 Phase 2, then:
#      3a/3b. Phase 2: apply the SQL with psql, then check counts and checksums unchanged, every indicator linked to a
#                 result, results chain placeholders follow the hierarchy rule, result codes unique per framework,
#                 primary sector in sectors, provenance (including an indicator added by hand to an AI-generated
#                 framework later), RLS on the new tables, the app's Prisma client can read the data, a second run is
#                 refused without changes, and `prisma migrate diff` against the schema at PHASE2_REV reports no drift.
#      3c.    Phase 3, negative runs first: while another session holds a lock on Document the file gives up after
#                 lock_timeout; copies of the file with a deliberate bug (no duplicate-key check, split at the first
#                 marker, transcripts not marked) are stopped by its self-check. Each run rolls back with every table
#                 unchanged. Then the real file is applied with psql.
#      3d.    checks after Phase 3: the AiCall table (columns, types, defaults, enum, indexes, foreign keys and their
#                 SET NULL / CASCADE behaviour), RLS on AiCall, the new columns, the legacy analysis move (split at the
#                 last marker; valid JSON moved as JSON, anything else as {legacyText}; documents without the marker
#                 untouched; nothing lost), transcripts marked, counts and checksums of everything else unchanged, the
#                 app's Prisma client creates and reads AiCall rows and reads the moved data, a second run is refused
#                 without changes, and `prisma migrate diff` against the schema at PHASE3_REV reports no drift.
#      3e.    Phase 4, negative runs first: while another session holds a write lock on Framework (an open write
#                 transaction) the file gives up after lock_timeout; copies of the file with a deliberate bug (row level
#                 security not enabled on KpiSuggestion, KpiSuggestion.resultId ON DELETE CASCADE instead of SET NULL,
#                 one SuggestionStatus value missing) are stopped by its self-check. Each run rolls back with every
#                 table and the schema unchanged. Then the real file is applied with psql.
#      3f.    checks after Phase 4: both tables (columns, types, defaults, enums, indexes, foreign keys) exactly as in
#                 prisma/schema.prisma, the foreign keys' behaviour on fixtures (a deleted result or indicator empties
#                 the link; a run with suggestions cannot be deleted; deleting a framework removes its runs and
#                 suggestions in one statement; a project with frameworks cannot be deleted), RLS on both with no
#                 policies, counts and checksums of every pre-existing table unchanged, the app's Prisma client writes
#                 and reads KPI rows, a second run is refused without changes, and no drift against prisma/schema.prisma.
#   4. CHAIN      the whole rollout order on the schema the shared Supabase database had before Phase 0
#                 (PRE_PHASE0_REV): the Phase 3 SQL is refused first, the Phase 4 SQL is refused after Phase 2, then the
#                 Phase 0, Phase 2, Phase 3 and Phase 4 files apply in order, RLS is on for every new table and
#                 `prisma migrate diff` reports no drift.
#   5. SUPABASE   the same rollout with pgvector in an `extensions` schema and the search_path Supabase gives its
#                 roles: the files apply, the extension stays where it is, no drift; with search_path = public (what
#                 a Prisma URL with ?schema=public sets) a bare ::vector cast fails, the column's own type works and the
#                 vector reads back as text (how Phase 4 retrieval reads library vectors).
#   6. CLEANUP    drop the throwaway databases (set KEEP_DBS=1 to keep them for inspection).
#
# Usage:   scripts/verify-migrations.sh            (npm run verify:migration)
# Options (environment variables):
#   VERIFY_PG_BASE_URL  server to create the throwaway databases on, without a database name
#                       (default: the local CI Postgres, postgresql://raqib:raqib@localhost:5432)
#   BASE_REV            git revision whose schema and seed represent the shared databases after the Phase 0 SQL
#                       (default 022e09a)
#   PHASE2_REV          git revision whose schema is the Phase 2 schema (default 642c474)
#   PHASE3_REV          git revision whose schema is the Phase 3 schema, what the Phase 4 SQL upgrades (default f010e7f)
#   PRE_PHASE0_REV      git revision whose schema the shared Supabase database had before the Phase 0 SQL
#                       (default df6c1f6)
#   KEEP_DBS=1          keep the databases at the end
#   VERIFY_ALLOW_NON_LOCAL=1  allow a server other than localhost (for example a CI service container); without it,
#                       URLs with a host= or hostaddr= parameter or a comma-separated host list are refused too
#
# Needs: psql, git history containing BASE_REV, PHASE2_REV, PHASE3_REV and PRE_PHASE0_REV, `npm ci` done, Postgres with
# pgvector. Never point it at
# a shared server: it only creates and drops databases whose names it generates. The names contain "verify", a unique
# run id (time, process id, random number) and end in "_test", so they cannot clash with anyone's test databases
# (raqib_test, raqib_<key>_test); CREATE DATABASE fails rather than reuse an existing name, and only databases this run
# created are dropped.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHASE0_SQL="$ROOT/prisma/sql/2026-10-11_phase0_webhook_tokens.sql"
PHASE2_SQL="$ROOT/prisma/sql/2026-10-11_phase2_data_model.sql"
PHASE3_SQL="$ROOT/prisma/sql/2026-10-12_phase3_ai_foundation.sql"
PHASE4_SQL="$ROOT/prisma/sql/2026-10-12_phase4_kpi_assistant.sql"
NEW_SCHEMA="$ROOT/prisma/schema.prisma"
BASE_REV="${BASE_REV:-022e09a}"
PHASE2_REV="${PHASE2_REV:-642c474}"
PHASE3_REV="${PHASE3_REV:-f010e7f}"
PRE_PHASE0_REV="${PRE_PHASE0_REV:-df6c1f6}"
PG_BASE_URL="${VERIFY_PG_BASE_URL:-postgresql://raqib:raqib@localhost:5432}"
PG_BASE_URL="${PG_BASE_URL%/}"
KEEP_DBS="${KEEP_DBS:-0}"
PRISMA="$ROOT/node_modules/.bin/prisma"
TSX="$ROOT/node_modules/.bin/tsx"

RUN_ID="$(date +%s)_$$_${RANDOM}"
FRESH_DB="raqib_mverify_fresh_${RUN_ID}_test"
EMPTY_DB="raqib_mverify_empty_${RUN_ID}_test"
PARTIAL_DB="raqib_mverify_partial_${RUN_ID}_test"
PARTIAL4_DB="raqib_mverify_partialp4_${RUN_ID}_test"
SEED_DB="raqib_mverify_seed_${RUN_ID}_test"
CHAIN_DB="raqib_mverify_chain_${RUN_ID}_test"
EXT_DB="raqib_mverify_ext_${RUN_ID}_test"
FRESH_URL="$PG_BASE_URL/$FRESH_DB"
EMPTY_URL="$PG_BASE_URL/$EMPTY_DB"
PARTIAL_URL="$PG_BASE_URL/$PARTIAL_DB"
PARTIAL4_URL="$PG_BASE_URL/$PARTIAL4_DB"
SEED_URL="$PG_BASE_URL/$SEED_DB"
CHAIN_URL="$PG_BASE_URL/$CHAIN_DB"
EXT_URL="$PG_BASE_URL/$EXT_DB"
# application_name of the session that holds a lock on Document in section 3c (and on Framework in section 3e).
BLOCKER_APP="raqib_mverify_blocker_${RUN_ID}"
BLOCKER_PID=""
ADMIN_URL="$PG_BASE_URL/postgres"
# For messages: the server without its password (in the user info or in a password= parameter).
SHOWN_URL="$(printf '%s' "$PG_BASE_URL" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#; s#([?&]password=)[^&]*#\1***#g')"
PG_HOST="$(printf '%s' "$PG_BASE_URL" | sed -E 's#^[a-z]+://([^@/]*@)?(\[[^]]*\]|[^:/]*).*$#\2#')"
# For the localhost guard: the host list (after the user info) and the query string, percent-decoded.
PG_HOSTS="$(printf '%s' "$PG_BASE_URL" | sed -E 's#^[a-z]+://##; s#[/?].*$##')"
PG_HOSTS="${PG_HOSTS##*@}"
PG_QUERY=""
[[ "$PG_BASE_URL" == *\?* ]] && PG_QUERY="${PG_BASE_URL#*\?}"
PG_QUERY="$(printf '%b' "${PG_QUERY//%/\\x}")"

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

# Creates a database, optionally as a copy of another one this run created (TEMPLATE; it must have no connections).
create_db() {
  local name="$1" template="${2:-}" sql
  [[ "$name" == *test* ]] || die "refusing to create database '$name': its name must contain \"test\""
  sql="CREATE DATABASE \"$name\""
  if [[ -n "$template" ]]; then
    [[ " ${CREATED_DBS[*]} " == *" $template "* ]] || die "refusing to copy '$template': this run did not create it"
    sql="$sql TEMPLATE \"$template\""
  fi
  psql "$ADMIN_URL" -X -q -v ON_ERROR_STOP=1 -c "$sql" >/dev/null
  CREATED_DBS+=("$name")
}

# Ends the session that holds a lock on Document (3c) or Framework (3e), if it is still there.
stop_blocker() {
  if [[ -n "$BLOCKER_PID" ]]; then
    psql "$ADMIN_URL" -X -q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '$BLOCKER_APP'" >/dev/null 2>&1 || true
    kill "$BLOCKER_PID" 2>/dev/null || true
    wait "$BLOCKER_PID" 2>/dev/null || true
    BLOCKER_PID=""
  fi
}

cleanup() {
  local status=$?
  stop_blocker
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

# Prints the drift between a database and a schema file; passes when there is none.
check_no_drift() {
  local url="$1" label="$2" schema="${3:-$NEW_SCHEMA}" out code=0
  out="$(cd "$ROOT" && DATABASE_URL="$url" DIRECT_URL="$url" "$PRISMA" migrate diff \
    --from-url "$url" --to-schema-datamodel "$schema" --script --exit-code 2>&1)" || code=$?
  if [[ $code -eq 0 ]]; then
    pass "$label"
  else
    fail "$label (prisma migrate diff exit code $code)"
    printf '%s\n' "$out" | sed 's/^/        /' | tail -n 60
  fi
}

# Writes the snapshot queries for a database to a file: per table, the row count and an md5 of every column that
# exists now, optionally minus the columns a SQL condition on c.table_name / c.column_name excludes. The file is
# built before a migration and reused after it, so columns added by the migration are not part of the comparison.
build_snapshot_sql() {
  local url="$1" out="$2" keep="${3:-true}"
  q "$url" "
    SELECT format(
      'SELECT %L, count(*), md5(coalesce(string_agg(r, E''\\n'' ORDER BY r), '''')) FROM (SELECT ROW(%s)::text AS r FROM public.%I) s;',
      c.table_name, string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position), c.table_name)
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND ($keep)
    GROUP BY c.table_name ORDER BY c.table_name" >"$out"
}
snapshot() { psql "$1" -X -At -F ' ' -v ON_ERROR_STOP=1 -f "$2"; }
print_snapshot() { awk '{ printf "        %-22s %6s rows  %s\n", $1, $2, $3 }' "$1"; }

# Runs a SQL file that must be refused: passes when psql fails with the expected error (not merely a notice) and the
# snapshot taken with the given snapshot file is unchanged.
expect_refused() {
  local url="$1" label="$2" file="$3" message="$4" snap_sql="$5" log before after
  log="$(mktemp "$WORK/refused.XXXXXX")"
  before="$(snapshot "$url" "$snap_sql")"
  if psql "$url" -X -q -v ON_ERROR_STOP=1 -f "$file" >"$log" 2>&1; then
    fail "$label (the file ran)"
  elif grep -qF "ERROR:  $message" "$log"; then
    after="$(snapshot "$url" "$snap_sql")"
    if [[ "$before" == "$after" ]]; then
      pass "$label"
    else
      fail "$label (refused, but data changed)"
    fi
  else
    fail "$label (failed for an unexpected reason):"
    sed 's/^/        /' "$log" | tail -n 20
  fi
}

# Copies a SQL file with one deliberate change (a "mutant"), for runs that the file's self-check must stop. Aborts
# unless the original text occurs exactly once, so a later edit of the file cannot silently make the mutant a no-op.
mutate() {
  local src="$1" dst="$2" from="$3" to="$4" content n
  n="$(grep -oF -- "$from" "$src" | wc -l | tr -d ' ')"
  [[ "$n" == "1" ]] || die "mutation: expected the text to change exactly once in $(basename "$src"), found it $n times: $from"
  content="$(cat "$src")"
  printf '%s\n' "${content/"$from"/"$to"}" >"$dst"
  cmp -s "$src" "$dst" && die "mutation did not change $(basename "$src")"
  return 0
}

# Schema objects in public (tables, indexes, sequences, types, functions, columns with types and defaults), as one
# md5: equal before and after a refused run means the run created and changed nothing.
SCHEMA_FP_SQL="SELECT count(*) || ' ' || md5(string_agg(x, ',' ORDER BY x)) FROM (
  SELECT 'class:' || relname || ':' || relkind::text FROM pg_class WHERE relnamespace = 'public'::regnamespace
  UNION ALL SELECT 'type:' || typname FROM pg_type WHERE typnamespace = 'public'::regnamespace
  UNION ALL SELECT 'proc:' || proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
  UNION ALL SELECT 'column:' || table_name || '.' || column_name || ':' || udt_name || ':' || is_nullable || ':' || coalesce(column_default, '')
            FROM information_schema.columns WHERE table_schema = 'public'
) s(x)"

# --- preconditions -----------------------------------------------------------------------------------------------

section "Preconditions"
command -v psql >/dev/null || die "psql not found"
# libpq connects to the host(s) of a host= or hostaddr= parameter, or tries every host of a comma-separated list,
# whatever the first host says: such URLs count as non-local too.
NON_LOCAL=""
if [[ "$PG_HOSTS" == *,* ]]; then
  NON_LOCAL="it lists several hosts"
elif [[ "&$PG_QUERY" =~ \&(host|hostaddr)= ]]; then
  NON_LOCAL="it has a host or hostaddr parameter"
else
  case "$PG_HOST" in
    localhost | 127.0.0.1 | "[::1]") ;;
    *) NON_LOCAL="not localhost" ;;
  esac
fi
if [[ -n "$NON_LOCAL" && "${VERIFY_ALLOW_NON_LOCAL:-0}" != "1" ]]; then
  die "refusing to use $SHOWN_URL: $NON_LOCAL (set VERIFY_ALLOW_NON_LOCAL=1 for a throwaway server)"
fi
[[ -x "$PRISMA" && -x "$TSX" ]] || die "node_modules missing: run npm ci first"
[[ -f "$PHASE0_SQL" ]] || die "missing $PHASE0_SQL"
[[ -f "$PHASE2_SQL" ]] || die "missing $PHASE2_SQL"
[[ -f "$PHASE3_SQL" ]] || die "missing $PHASE3_SQL"
[[ -f "$PHASE4_SQL" ]] || die "missing $PHASE4_SQL"
for rev in "$BASE_REV" "$PHASE2_REV" "$PHASE3_REV" "$PRE_PHASE0_REV"; do
  git -C "$ROOT" cat-file -e "$rev:prisma/schema.prisma" 2>/dev/null \
    || die "git revision $rev not found (in CI use actions/checkout with fetch-depth: 0)"
done
psql "$ADMIN_URL" -X -At -c 'select 1' >/dev/null 2>&1 || die "cannot connect to $SHOWN_URL (is Postgres running?)"
mkdir -p "$ROOT/node_modules/.cache"
# Inside node_modules so the generated old client and the old seed resolve the repo's packages; ignored by lint/tsc.
WORK="$(mktemp -d "$ROOT/node_modules/.cache/verify-migrations.XXXXXX")"
PHASE2_SCHEMA="$WORK/schema-phase2.prisma"
git -C "$ROOT" show "$PHASE2_REV:prisma/schema.prisma" >"$PHASE2_SCHEMA"
grep -q '^model ResultNode' "$PHASE2_SCHEMA" && ! grep -q '^model AiCall' "$PHASE2_SCHEMA" \
  || die "the schema at $PHASE2_REV is not the Phase 2 schema (ResultNode without AiCall)"
PHASE3_SCHEMA="$WORK/schema-phase3.prisma"
git -C "$ROOT" show "$PHASE3_REV:prisma/schema.prisma" >"$PHASE3_SCHEMA"
grep -q '^model AiCall' "$PHASE3_SCHEMA" && ! grep -q '^model KpiSuggestion' "$PHASE3_SCHEMA" \
  || die "the schema at $PHASE3_REV is not the Phase 3 schema (AiCall without KpiSuggestion)"
pass "tools, revisions $BASE_REV, $PHASE2_REV, $PHASE3_REV and $PRE_PHASE0_REV and database server $SHOWN_URL available"

# --- 0. static checks --------------------------------------------------------------------------------------------

section "0. Static checks of the SQL files"
for f in "$PHASE0_SQL" "$PHASE2_SQL" "$PHASE3_SQL" "$PHASE4_SQL"; do
  if sed 's/--.*$//' "$f" | grep -Eiq '(^|[^[:alnum:]_])DROP([^[:alnum:]_]|$)'; then
    fail "no DROP statement in $(basename "$f")"
    sed 's/--.*$//' "$f" | grep -Ein '(^|[^[:alnum:]_])DROP([^[:alnum:]_]|$)' | sed 's/^/        /'
  else
    pass "no DROP statement in $(basename "$f")"
  fi
done
# Outside comments: exactly one BEGIN and one COMMIT (and no other transaction control), BEGIN first and COMMIT last,
# so a failure anywhere rolls back everything.
for f in "$PHASE3_SQL" "$PHASE4_SQL"; do
  code_lines="$(sed 's/--.*$//' "$f" | grep -v '^[[:space:]]*$')"
  if [[ "$(grep -Ec '^BEGIN;$' "$f")" == "1" && "$(grep -Ec '^COMMIT;$' "$f")" == "1" ]] \
    && ! printf '%s\n' "$code_lines" | grep -Eiv '^(BEGIN|COMMIT);$' | grep -Eiq '(^|[^[:alnum:]_"])(COMMIT|ROLLBACK|END[[:space:]]+TRANSACTION|START[[:space:]]+TRANSACTION)([^[:alnum:]_"]|$)' \
    && [[ "$(printf '%s\n' "$code_lines" | head -n 1)" == "BEGIN;" ]] \
    && [[ "$(printf '%s\n' "$code_lines" | tail -n 1)" == "COMMIT;" ]]; then
    pass "$(basename "$f") is one transaction (first statement BEGIN, last COMMIT, no other transaction control)"
  else
    fail "$(basename "$f") is not exactly one transaction"
  fi
  if [[ "$(printf '%s\n' "$code_lines" | sed -n 2p)" == "SET LOCAL lock_timeout = '5s';" ]]; then
    pass "$(basename "$f") sets lock_timeout right after BEGIN (fails fast on a busy table; checked in 3c and 3e)"
  else
    fail "$(basename "$f") does not start with BEGIN; SET LOCAL lock_timeout = '5s';"
  fi
done

# The app's Prisma client creates, reads and deletes AiCall rows; with EXPECT_LEGACY_DOCS=1 it also reads the moved
# document analyses of the fixtures below.
cat >"$WORK/aicall-check.ts" <<'TS'
import { Prisma, PrismaClient } from '@prisma/client';

const MARKER = '---AI_ANALYSIS---';

function isObject(value: unknown): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function main() {
  const prisma = new PrismaClient();
  const problems: string[] = [];
  try {
    const project = await prisma.project.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, organizationId: true } });
    const ok = await prisma.aiCall.create({
      data: {
        feature: 'verify.migration', model: 'claude-haiku-5-5', servedModel: 'claude-haiku-5-5', promptVersion: 'verify-v1',
        systemPromptVersion: 'system-verify-v1', status: 'success', stopReason: 'end_turn', inputTokens: 1200, outputTokens: 340,
        cacheReadTokens: 900, latencyMs: 2150, estimatedCostUsd: new Prisma.Decimal('0.004321'),
        organizationId: project?.organizationId ?? null, projectId: project?.id ?? null,
      },
    });
    const refused = await prisma.aiCall.create({
      data: { feature: 'verify.migration', model: 'claude-sonnet-5-5', promptVersion: 'verify-v1', status: 'refusal', stopReason: 'refusal', errorType: 'AiRefusalError', latencyMs: 800 },
    });

    const read = await prisma.aiCall.findUniqueOrThrow({ where: { id: ok.id }, include: { organization: { select: { id: true } }, project: { select: { id: true } } } });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(read.id)) problems.push('id is not a uuid');
    if (read.attempts !== 1 || read.cacheWriteTokens !== 0) problems.push('column defaults not applied');
    if (read.inputTokens !== 1200 || read.outputTokens !== 340 || read.cacheReadTokens !== 900 || read.latencyMs !== 2150) problems.push('token or latency numbers changed');
    if (read.estimatedCostUsd?.toString() !== '0.004321') problems.push(`estimatedCostUsd read back as ${String(read.estimatedCostUsd)}`);
    if (Math.abs(Date.now() - read.createdAt.getTime()) > 10 * 60_000) problems.push('createdAt not set to the current time');
    if ((read.organization?.id ?? null) !== (project?.organizationId ?? null) || (read.project?.id ?? null) !== (project?.id ?? null)) problems.push('organization or project not linked');

    const readRefused = await prisma.aiCall.findUniqueOrThrow({ where: { id: refused.id } });
    if (readRefused.status !== 'refusal' || readRefused.errorType !== 'AiRefusalError' || readRefused.estimatedCostUsd !== null
      || readRefused.organizationId !== null || readRefused.servedModel !== null || readRefused.inputTokens !== 0) {
      problems.push('refused call not stored as written');
    }

    // The queries the indexes are for: recent calls of a feature, an organisation's and a project's recent calls,
    // cost by status.
    const recent = await prisma.aiCall.findMany({ where: { feature: 'verify.migration', createdAt: { gte: new Date(Date.now() - 3_600_000) } }, orderBy: { createdAt: 'desc' } });
    if (recent.length !== 2) problems.push(`expected 2 recent calls, got ${recent.length}`);
    if (project) {
      const orgCalls = await prisma.aiCall.count({ where: { organizationId: project.organizationId } });
      if (orgCalls !== 1) problems.push(`expected 1 call for the organisation, got ${orgCalls}`);
      const projectCalls = await prisma.aiCall.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 10 });
      if (projectCalls.length !== 1) problems.push(`expected 1 call for the project, got ${projectCalls.length}`);
    }
    const byStatus = await prisma.aiCall.groupBy({ by: ['status'], where: { feature: 'verify.migration' }, _sum: { estimatedCostUsd: true, inputTokens: true } });
    if (byStatus.length !== 2) problems.push('groupBy status did not return both statuses');

    await prisma.aiCall.deleteMany({ where: { id: { in: [ok.id, refused.id] } } });
    const left = await prisma.aiCall.count();
    if (left !== 0) problems.push(`${left} AiCall row(s) left`);

    // The other Phase 3 columns, as the app queries them: the current framework is the newest version without a
    // generationError; library entries without an embeddingModel are re-embedded; transcripts are left out of AI use.
    const failedVersions = await prisma.framework.count({ where: { generationError: { not: null } } });
    if (failedVersions !== 0) problems.push(`${failedVersions} framework(s) with a generationError`);
    if (project) {
      const frameworks = await prisma.framework.count({ where: { projectId: project.id } });
      const current = await prisma.framework.findFirst({ where: { projectId: project.id, generationError: null }, orderBy: { version: 'desc' }, select: { id: true } });
      if ((frameworks > 0) !== (current !== null)) problems.push('current framework (generationError: null) not found');
    }
    const libraryWithModel = await prisma.indicatorLibraryEntry.count({ where: { embeddingModel: { not: null } } });
    if (libraryWithModel !== 0) problems.push(`${libraryWithModel} library entr(ies) with an embeddingModel`);
    const forAi = await prisma.document.count({ where: { qualitativeSource: false } });
    const allDocuments = await prisma.document.count();

    let documents = 0;
    if (process.env.EXPECT_LEGACY_DOCS === '1') {
      const docs = await prisma.document.findMany({ select: { id: true, parsedText: true, aiAnalysis: true, qualitativeSource: true } });
      documents = docs.length;
      const byId = new Map(docs.map((d) => [d.id, d]));
      const json = byId.get('p3v-doc-json')?.aiAnalysis;
      if (!isObject(json) || json.summary !== 'Livelihoods proposal.' || !Array.isArray(json.targets_mentioned)) problems.push('legacy JSON analysis not read as an object');
      const bad = byId.get('p3v-doc-bad')?.aiAnalysis;
      if (!isObject(bad) || typeof bad.legacyText !== 'string') problems.push('legacy text analysis not read as {legacyText}');
      const deep = byId.get('p3v-doc-deep')?.aiAnalysis;
      if (!isObject(deep) || typeof deep.legacyText !== 'string') problems.push('deeply nested legacy analysis not read as {legacyText}');
      if (byId.get('p3v-doc-plain')?.aiAnalysis !== null) problems.push('a document without the marker has an analysis');
      // Only a document whose own text quotes the marker keeps it (the analysis after the last marker moved).
      const withMarker = docs.filter((d) => d.parsedText?.includes(MARKER)).map((d) => d.id).sort();
      if (withMarker.join(',') !== 'p3v-doc-twice') problems.push(`parsedText with the marker: ${withMarker.join(',') || 'none'} (expected p3v-doc-twice)`);
      const transcripts = docs.filter((d) => d.qualitativeSource).map((d) => d.id).sort();
      if (transcripts.join(',') !== 'p3v-doc-kii,p3v-doc-transcript') problems.push(`qualitativeSource documents: ${transcripts.join(',') || 'none'}`);
      if (forAi !== allDocuments - 2) problems.push(`expected ${allDocuments - 2} documents for AI use, got ${forAi}`);
    } else if (forAi !== allDocuments) {
      problems.push('a document is marked qualitativeSource');
    }

    console.log(JSON.stringify({ aiCallsWritten: 2, aiCallsLeft: left, documents, problems }));
    if (problems.length > 0) process.exit(2);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
TS

# The app's Prisma client writes, reads and deletes KPI runs and suggestions (Phase 4) as the application does, on a
# fixture organisation it creates and removes again: defaults, the heartbeat (updatedAt), a conditional update, accept
# and reject, the one-suggestion-per-indicator rule, the relations both ways, the queries the indexes serve, and a run
# with suggestions that cannot be deleted. All values are synthetic.
cat >"$WORK/kpi-check.ts" <<'TS'
import { Prisma, PrismaClient } from '@prisma/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function knownError(err: unknown, code: string): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}

async function main() {
  const prisma = new PrismaClient();
  const problems: string[] = [];
  let orgId: string | null = null;
  const before = { runs: await prisma.kpiSuggestionRun.count(), suggestions: await prisma.kpiSuggestion.count() };
  try {
    const org = await prisma.organization.create({
      data: { name: 'Verify KPI organisation (fixture)', type: 'local_ngo', country: 'Palestine', city: 'Hebron', contactEmail: 'verify-kpi@example.org' },
    });
    orgId = org.id;
    const project = await prisma.project.create({
      data: {
        organizationId: org.id, name: 'Verify KPI project (fixture)', sector: 'wash', donor: 'Verify donor', donorType: 'echo',
        startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), humanitarian: true,
      },
    });
    const framework = await prisma.framework.create({ data: { projectId: project.id, version: 1 } });
    const result = await prisma.resultNode.create({ data: { frameworkId: framework.id, level: 'outcome', code: 'O1', text: 'Verify outcome (fixture)' } });
    const indicator = await prisma.indicator.create({
      data: {
        frameworkId: framework.id, resultId: result.id, indicatorText: 'Verify indicator (fixture)', level: 'outcome',
        dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: [], provenance: 'ai_suggested',
      },
    });

    const run = await prisma.kpiSuggestionRun.create({
      data: { projectId: project.id, frameworkId: framework.id, scope: 'result', resultId: result.id, requestedBy: 'verify-user' },
    });
    if (!UUID.test(run.id)) problems.push('run id is not a uuid');
    if (run.status !== 'running' || run.step !== 'context' || run.suggestionCount !== 0 || run.modelCalls !== 0 || run.embeddingCalls !== 0
      || run.inputTokens !== 0 || run.outputTokens !== 0) problems.push('run defaults not applied');
    if (!Array.isArray(run.frameworkWarnings) || run.frameworkWarnings.length !== 0) problems.push('frameworkWarnings default is not []');
    if (run.estimatedCostUsd !== null || run.finishedAt !== null || run.errorCode !== null || run.error !== null || run.latencyMs !== null) problems.push('run optional columns not empty');
    if (Math.abs(Date.now() - run.updatedAt.getTime()) > 10 * 60_000 || Math.abs(Date.now() - run.createdAt.getTime()) > 10 * 60_000) problems.push('createdAt/updatedAt not set to the current time');

    const base = {
      projectId: project.id, frameworkId: framework.id, runId: run.id, resultId: result.id, level: 'outcome' as const,
      method: 'hh_survey' as const, model: 'claude-sonnet-5-5', promptVersion: 'kpi-v1',
    };
    const first = await prisma.kpiSuggestion.create({
      data: { ...base, payload: { name: 'Verify suggestion (fixture)', draft: { indicatorText: 'Verify suggestion (fixture)' } }, qualityScore: 85,
        warnings: [{ code: 'target_in_name', severity: 'warning', penalty: 15 }] },
    });
    if (!UUID.test(first.id)) problems.push('suggestion id is not a uuid');
    if (first.status !== 'pending' || first.sortOrder !== 0 || first.isCustom !== false || first.decidedAt !== null || first.indicatorId !== null) problems.push('suggestion defaults not applied');
    const alternative = await prisma.kpiSuggestion.create({
      data: { ...base, payload: { name: 'Verify alternative (fixture)' }, qualityScore: 100, isCustom: true, sortOrder: 1,
        alternativeOfSuggestionId: first.id, alternativeOfIndicatorId: indicator.id },
    });
    const plain = await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: alternative.id } });
    if (!Array.isArray(plain.warnings) || plain.warnings.length !== 0) problems.push('warnings default is not []');

    // Heartbeat and completion: every executor write is conditional on status running.
    await new Promise(resolve => setTimeout(resolve, 20));
    const done = await prisma.kpiSuggestionRun.update({
      where: { id: run.id, status: 'running' },
      data: { status: 'completed', step: 'done', suggestionCount: 2, estimatedCostUsd: new Prisma.Decimal('0.004321'), finishedAt: new Date(),
        frameworkWarnings: [{ code: 'result_cap', params: { cap: 3 } }], retrieval: 'keyword', model: 'claude-sonnet-5-5', promptVersion: 'kpi-v1' },
    });
    if (done.updatedAt.getTime() <= run.updatedAt.getTime()) problems.push('updatedAt did not move on update (heartbeat)');
    if (done.estimatedCostUsd?.toString() !== '0.004321') problems.push(`estimatedCostUsd read back as ${String(done.estimatedCostUsd)}`);
    const late = await prisma.kpiSuggestionRun.updateMany({ where: { id: run.id, status: 'running' }, data: { status: 'failed', errorCode: 'interrupted' } });
    if (late.count !== 0) problems.push('a conditional write changed a finished run');

    // Accept the first (it becomes the indicator), reject the alternative with a reason.
    await prisma.kpiSuggestion.update({ where: { id: first.id }, data: { status: 'accepted', decidedAt: new Date(), decidedBy: 'verify-user', indicatorId: indicator.id } });
    await prisma.kpiSuggestion.update({
      where: { id: alternative.id },
      data: { status: 'rejected', decidedAt: new Date(), decidedBy: 'verify-user', rejectReason: 'too_costly_to_measure', rejectNote: 'Verify note (fixture)' },
    });
    try {
      await prisma.kpiSuggestion.update({ where: { id: alternative.id }, data: { indicatorId: indicator.id } });
      problems.push('two suggestions were linked to one indicator');
    } catch (err) {
      if (!knownError(err, 'P2002')) problems.push(`linking a second suggestion to the indicator failed unexpectedly: ${err instanceof Error ? err.name : 'unknown'}`);
    }

    const read = await prisma.kpiSuggestionRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { suggestions: { orderBy: { sortOrder: 'asc' }, include: { alternatives: true, alternativeOfSuggestion: true, indicator: true } }, result: true, framework: true, project: true },
    });
    if (read.suggestions.map(sg => sg.id).join(',') !== `${first.id},${alternative.id}`) problems.push('run.suggestions not read back in order');
    if (read.suggestions[0].alternatives.map(a => a.id).join(',') !== alternative.id) problems.push('alternatives relation not read back');
    if (read.suggestions[1].alternativeOfSuggestion?.id !== first.id) problems.push('alternativeOfSuggestion not read back');
    if (read.suggestions[0].indicator?.id !== indicator.id) problems.push('accepted indicator not linked');
    if (read.result?.id !== result.id || read.framework.id !== framework.id || read.project.id !== project.id) problems.push('run relations not read back');
    const json = read.frameworkWarnings as Prisma.JsonArray;
    if (JSON.stringify(json) !== '[{"code":"result_cap","params":{"cap":3}}]') problems.push('frameworkWarnings not read back as written');
    const fromIndicator = await prisma.indicator.findUniqueOrThrow({ where: { id: indicator.id }, include: { acceptedFromSuggestion: true, kpiAlternatives: true, kpiRunsAsSource: true } });
    if (fromIndicator.acceptedFromSuggestion?.id !== first.id || fromIndicator.kpiAlternatives.map(a => a.id).join(',') !== alternative.id) problems.push('indicator back-relations not read back');

    // The queries the indexes are for: a project's pending cards, a framework's running runs, an organisation's
    // rejections by library id (orgPreferences), a run's suggestions, a result's suggestions.
    const pending = await prisma.kpiSuggestion.count({ where: { projectId: project.id, status: 'pending' } });
    const running = await prisma.kpiSuggestionRun.count({ where: { frameworkId: framework.id, status: 'running' } });
    const rejected = await prisma.kpiSuggestion.findMany({ where: { project: { organizationId: org.id }, status: 'rejected' }, select: { libraryId: true, rejectReason: true } });
    const byResult = await prisma.kpiSuggestion.count({ where: { resultId: result.id } });
    const recentRuns = await prisma.kpiSuggestionRun.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 5 });
    if (pending !== 0 || running !== 0 || rejected.length !== 1 || rejected[0].rejectReason !== 'too_costly_to_measure' || byResult !== 2 || recentRuns.length !== 1) {
      problems.push(`index queries returned pending=${pending} running=${running} rejected=${rejected.length} byResult=${byResult} runs=${recentRuns.length}`);
    }

    // Feedback history is never lost by pruning runs: a run with suggestions cannot be deleted.
    try {
      await prisma.kpiSuggestionRun.delete({ where: { id: run.id } });
      problems.push('a run with suggestions was deleted');
    } catch (err) {
      if (!knownError(err, 'P2003')) problems.push(`deleting a run with suggestions failed unexpectedly: ${err instanceof Error ? err.name : 'unknown'}`);
    }
    if (await prisma.kpiSuggestion.count({ where: { runId: run.id } }) !== 2) problems.push('suggestions lost when the run delete was refused');

    await prisma.kpiSuggestion.deleteMany({ where: { runId: run.id } });
    await prisma.kpiSuggestionRun.delete({ where: { id: run.id } });
  } finally {
    if (orgId) {
      await prisma.indicator.deleteMany({ where: { framework: { project: { organizationId: orgId } } } });
      await prisma.framework.deleteMany({ where: { project: { organizationId: orgId } } });
      await prisma.project.deleteMany({ where: { organizationId: orgId } });
      await prisma.organization.delete({ where: { id: orgId } });
    }
  }
  const after = { runs: await prisma.kpiSuggestionRun.count(), suggestions: await prisma.kpiSuggestion.count() };
  if (after.runs !== before.runs || after.suggestions !== before.suggestions) problems.push(`KPI rows left behind: ${JSON.stringify({ before, after })}`);
  await prisma.$disconnect();
  console.log(JSON.stringify({ kpiRunsWritten: 1, kpiSuggestionsWritten: 2, problems }));
  if (problems.length > 0) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
TS

# --- 1. fresh database -------------------------------------------------------------------------------------------

section "1. Fresh database: prisma db push of the current schema"
create_db "$FRESH_DB"
info "created $FRESH_DB"
run_quiet "prisma db push succeeds on an empty database" \
  in_dir "$ROOT" env DATABASE_URL="$FRESH_URL" DIRECT_URL="$FRESH_URL" "$PRISMA" db push --skip-generate
check_no_drift "$FRESH_URL" "no drift between the fresh database and prisma/schema.prisma"
build_snapshot_sql "$FRESH_URL" "$WORK/snapshot-fresh.sql"
expect_refused "$FRESH_URL" "Phase 3 SQL refused on a database that already has the Phase 3 schema, nothing changed" \
  "$PHASE3_SQL" "Phase 3 migration already applied" "$WORK/snapshot-fresh.sql"
expect_refused "$FRESH_URL" "Phase 4 SQL refused on a database that already has the Phase 4 schema, nothing changed" \
  "$PHASE4_SQL" "Phase 4 migration already applied" "$WORK/snapshot-fresh.sql"
run_quiet "the app's Prisma client creates, reads and deletes AiCall rows (fresh database)" \
  in_dir "$ROOT" env DATABASE_URL="$FRESH_URL" DIRECT_URL="$FRESH_URL" "$TSX" "$WORK/aicall-check.ts"
run_quiet "the app's Prisma client writes, reads and deletes KPI runs and suggestions (fresh database)" \
  in_dir "$ROOT" env DATABASE_URL="$FRESH_URL" DIRECT_URL="$FRESH_URL" "$TSX" "$WORK/kpi-check.ts"

# --- 2. empty database -------------------------------------------------------------------------------------------

section "2. Empty database: the Phase 3 SQL needs Phase 0 and Phase 2, the Phase 4 SQL needs Phase 3"
create_db "$EMPTY_DB"
info "created $EMPTY_DB"
# Objects in public (whatever template1 brings along), before and after: the refused run must create none.
OBJECTS_SQL="SELECT (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace) || ' ' ||
                    (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace) || ' ' ||
                    (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)"
OBJECTS_BEFORE="$(q "$EMPTY_URL" "$OBJECTS_SQL")"
if psql "$EMPTY_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE3_SQL" >"$WORK/empty.log" 2>&1; then
  fail "Phase 3 SQL ran on a database without the Phase 0 schema"
elif grep -qF "ERROR:  Phase 3 migration needs the Phase 0 SQL first" "$WORK/empty.log"; then
  pass "Phase 3 SQL refused on a database without the Phase 0 schema (\"needs the Phase 0 SQL first\")"
else
  fail "Phase 3 SQL failed on the empty database for an unexpected reason:"
  sed 's/^/        /' "$WORK/empty.log" | tail -n 20
fi
expect_eq "$EMPTY_URL" "the refused run created nothing (tables, types and functions in public: $OBJECTS_BEFORE)" \
  "$OBJECTS_BEFORE" "$OBJECTS_SQL"
# A leftover of a half-done attempt (here the enum type alone) is refused too, before anything else is checked.
q "$EMPTY_URL" "CREATE TYPE \"AiCallStatus\" AS ENUM ('success')" >/dev/null
OBJECTS_BEFORE="$(q "$EMPTY_URL" "$OBJECTS_SQL")"
if psql "$EMPTY_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE3_SQL" >"$WORK/partly.log" 2>&1; then
  fail "Phase 3 SQL ran on a database with a leftover AiCallStatus type"
elif grep -qF "ERROR:  Phase 3 migration already partly applied" "$WORK/partly.log" \
  && [[ "$(q "$EMPTY_URL" "$OBJECTS_SQL")" == "$OBJECTS_BEFORE" ]]; then
  pass "Phase 3 SQL refused on a database with a leftover AiCallStatus type (\"already partly applied\"), nothing changed"
else
  fail "Phase 3 SQL on a database with a leftover AiCallStatus type:"
  sed 's/^/        /' "$WORK/partly.log" | tail -n 20
fi
# The Phase 4 file on the same database (no Phase 3 schema; the AiCallStatus leftover above is not one of its own).
OBJECTS_BEFORE="$(q "$EMPTY_URL" "$OBJECTS_SQL")"
if psql "$EMPTY_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE4_SQL" >"$WORK/empty4.log" 2>&1; then
  fail "Phase 4 SQL ran on a database without the Phase 3 schema"
elif grep -qF "ERROR:  Phase 4 migration needs the Phase 3 SQL first" "$WORK/empty4.log" \
  && [[ "$(q "$EMPTY_URL" "$OBJECTS_SQL")" == "$OBJECTS_BEFORE" ]]; then
  pass "Phase 4 SQL refused on a database without the Phase 3 schema (\"needs the Phase 3 SQL first\"), created nothing"
else
  fail "Phase 4 SQL on a database without the Phase 3 schema:"
  sed 's/^/        /' "$WORK/empty4.log" | tail -n 20
fi
q "$EMPTY_URL" "CREATE TYPE \"SuggestionStatus\" AS ENUM ('pending')" >/dev/null
OBJECTS_BEFORE="$(q "$EMPTY_URL" "$OBJECTS_SQL")"
if psql "$EMPTY_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE4_SQL" >"$WORK/partly4.log" 2>&1; then
  fail "Phase 4 SQL ran on a database with a leftover SuggestionStatus type"
elif grep -qF "ERROR:  Phase 4 migration already partly applied" "$WORK/partly4.log" \
  && [[ "$(q "$EMPTY_URL" "$OBJECTS_SQL")" == "$OBJECTS_BEFORE" ]]; then
  pass "Phase 4 SQL refused on a database with a leftover SuggestionStatus type (\"already partly applied\"), nothing changed"
else
  fail "Phase 4 SQL on a database with a leftover SuggestionStatus type:"
  sed 's/^/        /' "$WORK/partly4.log" | tail -n 20
fi

# --- 2b. partly applied ------------------------------------------------------------------------------------------

section "2b. Partly applied: one leftover Phase 3 object on a database at the Phase 2 schema ($PHASE2_REV), one leftover Phase 4 object at the Phase 3 schema ($PHASE3_REV)"
create_db "$PARTIAL_DB"
info "created $PARTIAL_DB"
run_quiet "schema at $PHASE2_REV pushed (what the Phase 3 SQL upgrades)" \
  in_dir "$WORK" env DATABASE_URL="$PARTIAL_URL" DIRECT_URL="$PARTIAL_URL" "$PRISMA" db push --schema "$PHASE2_SCHEMA" --skip-generate
# Each case on its own copy of that database: the leftover, then the name the refusal must give.
PARTIAL_CASES=(
  'ALTER TABLE "Document" ADD COLUMN "aiAnalysis" JSONB|column "Document"."aiAnalysis"'
  'ALTER TABLE "Document" ADD COLUMN "qualitativeSource" BOOLEAN NOT NULL DEFAULT false|column "Document"."qualitativeSource"'
  'ALTER TABLE "Framework" ADD COLUMN "generationError" TEXT|column "Framework"."generationError"'
  'ALTER TABLE "IndicatorLibraryEntry" ADD COLUMN "embeddingModel" TEXT|column "IndicatorLibraryEntry"."embeddingModel"'
  "CREATE TYPE \"AiCallStatus\" AS ENUM ('success')|type \"AiCallStatus\""
)
PARTIAL_N=0
for partial_case in "${PARTIAL_CASES[@]}"; do
  PARTIAL_N=$((PARTIAL_N + 1))
  IFS='|' read -r leftover_sql leftover_name <<<"$partial_case"
  copy_db="raqib_mverify_partial${PARTIAL_N}_${RUN_ID}_test"
  create_db "$copy_db" "$PARTIAL_DB"
  copy_url="$PG_BASE_URL/$copy_db"
  q "$copy_url" "$leftover_sql" >/dev/null
  fp_before="$(q "$copy_url" "$SCHEMA_FP_SQL")"
  if psql "$copy_url" -X -q -v ON_ERROR_STOP=1 -f "$PHASE3_SQL" >"$WORK/partial$PARTIAL_N.log" 2>&1; then
    fail "Phase 3 SQL ran on a Phase 2 database with a leftover $leftover_name"
  elif grep -qF "ERROR:  Phase 3 migration already partly applied: $leftover_name exist(s) without table \"AiCall\"" "$WORK/partial$PARTIAL_N.log" \
    && [[ "$(q "$copy_url" "$SCHEMA_FP_SQL")" == "$fp_before" ]]; then
    pass "Phase 3 SQL refused on a Phase 2 database with a leftover $leftover_name (\"already partly applied\", named), nothing changed"
  else
    fail "Phase 3 SQL on a Phase 2 database with a leftover $leftover_name:"
    sed 's/^/        /' "$WORK/partial$PARTIAL_N.log" | tail -n 20
  fi
done

info "Phase 4: one leftover Phase 4 object on a database at the Phase 3 schema ($PHASE3_REV)"
create_db "$PARTIAL4_DB"
info "created $PARTIAL4_DB"
run_quiet "schema at $PHASE3_REV pushed (what the Phase 4 SQL upgrades)" \
  in_dir "$WORK" env DATABASE_URL="$PARTIAL4_URL" DIRECT_URL="$PARTIAL4_URL" "$PRISMA" db push --schema "$PHASE3_SCHEMA" --skip-generate
PARTIAL4_CASES=(
  "CREATE TYPE \"SuggestionStatus\" AS ENUM ('pending')|type \"SuggestionStatus\""
  "CREATE TYPE \"SuggestionRejectReason\" AS ENUM ('other')|type \"SuggestionRejectReason\""
  "CREATE TYPE \"KpiRunScope\" AS ENUM ('framework')|type \"KpiRunScope\""
  "CREATE TYPE \"KpiRunStatus\" AS ENUM ('running')|type \"KpiRunStatus\""
  'CREATE TABLE "KpiSuggestionRun" ("id" TEXT NOT NULL PRIMARY KEY)|table "KpiSuggestionRun"'
)
for partial_case in "${PARTIAL4_CASES[@]}"; do
  PARTIAL_N=$((PARTIAL_N + 1))
  IFS='|' read -r leftover_sql leftover_name <<<"$partial_case"
  copy_db="raqib_mverify_partial${PARTIAL_N}_${RUN_ID}_test"
  create_db "$copy_db" "$PARTIAL4_DB"
  copy_url="$PG_BASE_URL/$copy_db"
  q "$copy_url" "$leftover_sql" >/dev/null
  fp_before="$(q "$copy_url" "$SCHEMA_FP_SQL")"
  if psql "$copy_url" -X -q -v ON_ERROR_STOP=1 -f "$PHASE4_SQL" >"$WORK/partial$PARTIAL_N.log" 2>&1; then
    fail "Phase 4 SQL ran on a Phase 3 database with a leftover $leftover_name"
  elif grep -qF "ERROR:  Phase 4 migration already partly applied: $leftover_name exist(s) without table \"KpiSuggestion\"" "$WORK/partial$PARTIAL_N.log" \
    && [[ "$(q "$copy_url" "$SCHEMA_FP_SQL")" == "$fp_before" ]]; then
    pass "Phase 4 SQL refused on a Phase 3 database with a leftover $leftover_name (\"already partly applied\", named), nothing changed"
  else
    fail "Phase 4 SQL on a Phase 3 database with a leftover $leftover_name:"
    sed 's/^/        /' "$WORK/partial$PARTIAL_N.log" | tail -n 20
  fi
done

# --- 3. copy of the current seed -----------------------------------------------------------------------------------

section "3. Copy of the current seed (schema and seed at $BASE_REV)"
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
# without aiModelUsed with outcome and activity indicators (gaps in the chain), an empty framework, two indicators
# added to the seed's AI-generated framework after generation (one a day later, added by hand, one exactly at the
# one-hour limit), and a beneficiary with a service so those tables are part of the checksums. All values are synthetic.
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
  INSERT INTO \"Indicator\" (id, \"frameworkId\", \"indicatorText\", level, \"dataCollectionMethod\", frequency, phases, \"createdAt\")
  SELECT x.id, f.id, x.txt, 'output', 'document_review', 'quarterly', '[]', f.\"generatedAt\" + x.delay
  FROM (SELECT id, \"generatedAt\" FROM \"Framework\" WHERE id NOT LIKE 'p2v-%' AND \"aiModelUsed\" IS NOT NULL AND \"aiModelUsed\" <> 'manual'
        ORDER BY \"generatedAt\", id LIMIT 1) f,
       (VALUES ('p2v-ind-6', 'Number of referrals made (fixture, added by hand a day after generation)', interval '1 day'),
               ('p2v-ind-7', 'Number of follow-up visits (fixture, created at the one-hour limit)', interval '1 hour')) AS x(id, txt, delay);
  INSERT INTO \"Beneficiary\" (id, \"projectId\", \"fullName\", gender, \"ageGroup\", governorate, \"updatedAt\")
  SELECT 'p2v-ben-1', id, 'Fixture Person', 'female', 'youth_18_24', 'Hebron', now() FROM \"Project\" ORDER BY \"createdAt\", id LIMIT 1;
  INSERT INTO \"BeneficiaryService\" (id, \"beneficiaryId\", \"projectId\", \"serviceType\", \"dateProvided\", quantity, unit, \"indicatorId\")
  SELECT 'p2v-svc-1', 'p2v-ben-1', \"projectId\", 'training', now(), 3, 'sessions', 'p2v-ind-1' FROM \"Beneficiary\" WHERE id = 'p2v-ben-1';
"

# Documents as the old parser stored them: `<text>\n\n---AI_ANALYSIS---\n<model answer>` in parsedText, plus documents
# without the marker. Added before the Phase 2 snapshot, so Phase 2 must leave them alone too. All values are synthetic.
# The expected result of the Phase 3 data move for each one is in section 3c.
cat >"$WORK/documents.sql" <<'SQL'
INSERT INTO "Document" (id, "projectId", "uploadedBy", "fileName", "fileUrl", "fileType", "parsedText", "parsingStatus")
SELECT x.id, p.id, u.id, x.id || '.pdf', 'documents/verify/' || x.id || '.pdf', x.ft::"DocumentType", x.pt,
       CASE WHEN x.pt IS NULL THEN 'pending' ELSE 'completed' END::"ParsingStatus"
FROM (SELECT id FROM "Project" ORDER BY "createdAt", id LIMIT 1) p,
     (SELECT id FROM "User" ORDER BY "createdAt", id LIMIT 1) u,
     (VALUES
       ('p3v-doc-json', 'proposal', E'Livelihoods proposal for Hebron. Baseline: 41% of households have acceptable FCS (2025 survey).\n\n---AI_ANALYSIS---\n{"document_type":"proposal","summary":"Livelihoods proposal.","key_findings":["Baseline FCS 41%"],"indicators_mentioned":["% of households with acceptable FCS"],"targets_mentioned":[{"indicator":"FCS","target":"60%","timeline":"2027"}],"recommendations":["Add sex disaggregation"]}'),
       ('p3v-doc-bad', 'baseline_report', E'Baseline report text.\n\n---AI_ANALYSIS---\n{"summary": "Answer cut off at max_tok'),
       ('p3v-doc-plain', 'other', E'Plain text without an analysis.\n\n'),
       ('p3v-doc-null', 'other', NULL),
       ('p3v-doc-like', 'other', 'Text with ---AIXANALYSIS--- and ---AI ANALYSIS--- look-alikes.'),
       ('p3v-doc-array', 'budget', E'Budget lines.\n\n---AI_ANALYSIS---\n["not", "an", "object"]'),
       ('p3v-doc-dup', 'logframe', E'Logframe.\n\n---AI_ANALYSIS---\n{"summary":"first","summary":"second"}'),
       ('p3v-doc-dupnested', 'logframe', E'Logframe v2.\n\n---AI_ANALYSIS---\n{"summary":"ok","targets_mentioned":[{"target":"60%","target":"70%"}]}'),
       ('p3v-doc-twice', 'donor_guidelines', E'Guidelines quoting ---AI_ANALYSIS--- in the text.\n\n---AI_ANALYSIS---\n{"summary":"s"}'),
       ('p3v-doc-quoteonly', 'other', 'A note that quotes ---AI_ANALYSIS--- but got no analysis.'),
       ('p3v-doc-overlap', 'other', E'Overlap.\n\n---AI_ANALYSIS---AI_ANALYSIS---\n{"summary":"overlap"}'),
       ('p3v-doc-deep', 'baseline_report', E'Deep.\n\n---AI_ANALYSIS---\n{"a":' || repeat('[', 600) || '1' || repeat(']', 600) || '}'),
       ('p3v-doc-transcript', 'other', E'Participant 3 said the water point is far.\n\n---AI_ANALYSIS---\n{"summary":"FGD on water access."}'),
       ('p3v-doc-transcript2', 'other', 'Transcript attached from another project''s entry.'),
       ('p3v-doc-kii', 'other', 'KII notes: the clinic opens twice a week.'),
       ('p3v-doc-empty', 'other', E'Text only.\n\n---AI_ANALYSIS---\n  \n'),
       ('p3v-doc-arabic', 'proposal', E'مقترح مشروع سبل العيش في الخليل.\n\n---AI_ANALYSIS---\n{"summary":"ملخص المقترح","keyFindings":["نسبة الأسر ٤١٪"]}'),
       ('p3v-doc-only', 'theory_of_change', E'---AI_ANALYSIS---\n{"summary":"only the analysis"}'),
       ('p3v-doc-nul', 'other', E'Text.\n\n---AI_ANALYSIS---\n' || '{"summary":"a\u0000b"}'),
       ('p3v-doc-crlf', 'baseline_report', E'Survey text \t\r\n\r\n---AI_ANALYSIS---\r\n{"summary":"crlf"}\r\n')
     ) AS x(id, ft, pt);
-- Qualitative entries as the old upload route created them ({documentId, fileName} in attachments) and look-alikes
-- that must not mark a document: an entry of another project, attachments that are an object, a string or a number.
INSERT INTO "QualitativeEntry" (id, "projectId", "entryType", title, content, attachments)
SELECT x.id, CASE WHEN x.other THEN p2.id ELSE p1.id END, x.et::"QualitativeType", x.id, 'Fixture content.', x.att::jsonb
FROM (SELECT id FROM "Project" ORDER BY "createdAt", id LIMIT 1) p1,
     (SELECT id FROM "Project" ORDER BY "createdAt", id OFFSET 1 LIMIT 1) p2,
     (VALUES
       ('p3v-qe-upload', 'fgd_transcript', false, '[{"documentId":"p3v-doc-transcript","fileName":"p3v-doc-transcript.pdf"}]'),
       ('p3v-qe-second', 'kii_notes', false, '[{"fileName":"no-id.pdf"}, {"documentId":"p3v-doc-kii","fileName":"p3v-doc-kii.pdf"}]'),
       ('p3v-qe-otherproject', 'fgd_transcript', true, '[{"documentId":"p3v-doc-transcript2","fileName":"p3v-doc-transcript2.pdf"}]'),
       ('p3v-qe-object', 'field_notes', false, '{"documentId":"p3v-doc-plain"}'),
       ('p3v-qe-scalars', 'field_notes', false, '["p3v-doc-like", {"documentId": 42}, null, {"documentId": ["p3v-doc-json"]}]'),
       ('p3v-qe-none', 'msc_story', false, NULL)
     ) AS x(id, et, other, att);
SQL
run_quiet "legacy document fixtures added (20 documents, 15 with the ---AI_ANALYSIS--- marker; 6 qualitative entries)" \
  psql "$SEED_URL" -X -q -v ON_ERROR_STOP=1 -f "$WORK/documents.sql"

# Snapshot queries are built now, from the OLD columns, and reused after the migration.
SNAP_SQL="$WORK/snapshot.sql"
build_snapshot_sql "$SEED_URL" "$SNAP_SQL"
snapshot "$SEED_URL" "$SNAP_SQL" >"$WORK/before.txt"
TABLES="$(wc -l <"$WORK/before.txt" | tr -d ' ')"
info "snapshot of $TABLES existing tables (row count + md5 of every existing column):"
print_snapshot "$WORK/before.txt"

expect_refused "$SEED_URL" "Phase 3 SQL refused before the Phase 2 SQL (\"needs the Phase 2 SQL first\"), nothing changed" \
  "$PHASE3_SQL" "Phase 3 migration needs the Phase 2 SQL first" "$SNAP_SQL"
expect_eq "$SEED_URL" "the refused Phase 3 run left no AiCallStatus type and no Document.aiAnalysis column" "0|0" \
  "SELECT (SELECT count(*) FROM pg_type WHERE typname = 'AiCallStatus') || '|' ||
          (SELECT count(*) FROM information_schema.columns WHERE table_name = 'Document' AND column_name = 'aiAnalysis')"

EXPECTED_NODES="$(q "$SEED_URL" 'SELECT count(*) FROM (SELECT DISTINCT "frameworkId", level FROM "Indicator") s')"

section "3a. Phase 2 SQL"
run_quiet "Phase 2 SQL applied with psql -v ON_ERROR_STOP=1" \
  psql "$SEED_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE2_SQL"

section "3b. Checks after the Phase 2 SQL"
snapshot "$SEED_URL" "$SNAP_SQL" >"$WORK/after.txt"
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
expect_zero "$S" "provenance: ai_generated with aiModel when aiModelUsed is a model id and the indicator was created within 1 hour of the framework, else manual" \
  "SELECT count(*) FROM \"Indicator\" i JOIN \"Framework\" f ON f.id = i.\"frameworkId\"
   CROSS JOIN LATERAL (SELECT f.\"aiModelUsed\" IS NOT NULL AND f.\"aiModelUsed\" <> 'manual'
                              AND i.\"createdAt\" <= f.\"generatedAt\" + interval '1 hour' AS ai) g
   WHERE (NOT g.ai AND (i.provenance <> 'manual' OR i.\"aiModel\" IS NOT NULL))
      OR (g.ai AND (i.provenance <> 'ai_generated' OR i.\"aiModel\" IS DISTINCT FROM f.\"aiModelUsed\"))"
expect_eq "$S" "indicator added by hand to the AI seed framework a day after generation is manual, without aiModel" "manual|" \
  "SELECT provenance || '|' || coalesce(\"aiModel\", '') FROM \"Indicator\" WHERE id = 'p2v-ind-6'"
expect_eq "$S" "indicator created exactly 1 hour after the AI seed framework is ai_generated with the framework's model" "ai_generated|true" \
  "SELECT i.provenance || '|' || (i.\"aiModel\" = f.\"aiModelUsed\") FROM \"Indicator\" i JOIN \"Framework\" f ON f.id = i.\"frameworkId\" WHERE i.id = 'p2v-ind-7'"
expect_zero "$S" "the seed generator's own indicators stay ai_generated" \
  "SELECT count(*) FROM \"Indicator\" i JOIN \"Framework\" f ON f.id = i.\"frameworkId\"
   WHERE i.id NOT LIKE 'p2v-%' AND f.\"aiModelUsed\" IS NOT NULL AND f.\"aiModelUsed\" <> 'manual' AND i.provenance <> 'ai_generated'"
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
check_no_drift "$S" "no drift between the migrated database and the Phase 2 schema ($PHASE2_REV)" "$PHASE2_SCHEMA"

# A result code is unique within a framework (ResultNode_frameworkId_code_key): a direct write of a second "O" in a
# framework that has the "O" placeholder is rejected. The transaction is rolled back in any case.
DUP_SQL="BEGIN; INSERT INTO \"ResultNode\" (id, \"frameworkId\", level, code, text)
  SELECT 'p2v-dup-code', \"frameworkId\", 'outcome', 'O', 'Duplicate code (fixture)' FROM \"ResultNode\" WHERE code = 'O' ORDER BY id LIMIT 1;
  ROLLBACK;"
if psql "$S" -X -q -v ON_ERROR_STOP=1 -c "$DUP_SQL" >"$WORK/dup.log" 2>&1; then
  fail "a duplicate result code in a framework was not rejected"
elif grep -q 'ResultNode_frameworkId_code_key' "$WORK/dup.log"; then
  pass "a duplicate result code in a framework is rejected by the unique index"
else
  fail "duplicate result code insert failed for an unexpected reason:"
  sed 's/^/        /' "$WORK/dup.log" | tail -n 20
fi

# The app's Prisma client can read the migrated data (it only touches Phase 2 tables here, which Phase 3 leaves as they
# are; it runs again after the Phase 3 SQL).
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
snapshot "$SEED_URL" "$SNAP_SQL" >"$WORK/after1.txt"
q "$S" "$NODES_SQL" >"$WORK/nodes1.txt"
if psql "$SEED_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE2_SQL" >"$WORK/rerun.log" 2>&1; then
  fail "second run was not refused"
elif grep -q "already applied" "$WORK/rerun.log"; then
  snapshot "$SEED_URL" "$SNAP_SQL" >"$WORK/after2.txt"
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

info "after the Phase 2 SQL: $(q "$S" 'SELECT count(*) FROM "ResultNode"') result nodes, $(q "$S" 'SELECT count(*) FROM "Indicator"') indicators linked, $(q "$S" 'SELECT count(*) FROM "Project"') projects, IndicatorLibraryEntry rows: $(q "$S" 'SELECT count(*) FROM "IndicatorLibraryEntry"') (filled later by npm run seed:library)"

# --- 3c/3d. Phase 3 on the same database ---------------------------------------------------------------------------

section "3c. Phase 3 SQL (on the database after the Phase 2 SQL)"
# Snapshot of every column of every table as it is after Phase 2, except Document.parsedText (the only existing column
# the data move may change; checked document by document below). The old parsedText values are kept in a file.
SNAP3_SQL="$WORK/snapshot3.sql"
build_snapshot_sql "$S" "$SNAP3_SQL" "NOT (c.table_name = 'Document' AND c.column_name = 'parsedText')"
snapshot "$S" "$SNAP3_SQL" >"$WORK/before3.txt"
TABLES3="$(wc -l <"$WORK/before3.txt" | tr -d ' ')"
psql "$S" -X -q -v ON_ERROR_STOP=1 -c "\\copy (SELECT id, \"parsedText\" FROM \"Document\" ORDER BY id) TO '$WORK/documents-before.csv' WITH (FORMAT csv)"
LEGACY_DOCS="$(q "$S" "SELECT count(*) FROM \"Document\" WHERE strpos(\"parsedText\", '---AI_ANALYSIS---') > 0")"
info "snapshot of $TABLES3 tables; $(q "$S" 'SELECT count(*) FROM "Document"') documents, $LEGACY_DOCS with the ---AI_ANALYSIS--- marker"

# Negative runs first, each on its own copy of this database (so a run that wrongly commits cannot spoil the real
# one): each must stop with the expected error and leave every column of every table (parsedText included) and the
# schema exactly as they were.
SNAP3_ALL_SQL="$WORK/snapshot3-all.sql"
build_snapshot_sql "$S" "$SNAP3_ALL_SQL"
NEG_N=0
NEG_URL=""
new_seed_copy() {
  NEG_N=$((NEG_N + 1))
  local name="raqib_mverify_neg${NEG_N}_${RUN_ID}_test"
  create_db "$name" "$SEED_DB"
  NEG_URL="$PG_BASE_URL/$name"
}
# The optional fifth argument is the snapshot file to compare (default: every column after Phase 2, for Phase 3).
expect_rollback() {
  local url="$1" label="$2" file="$3" message="$4" snap_sql="${5:-$SNAP3_ALL_SQL}" log before fp_before
  log="$(mktemp "$WORK/rollback.XXXXXX")"
  before="$(snapshot "$url" "$snap_sql")"
  fp_before="$(q "$url" "$SCHEMA_FP_SQL")"
  if psql "$url" -X -q -v ON_ERROR_STOP=1 -f "$file" >"$log" 2>&1; then
    fail "$label (the file ran and committed)"
  elif grep -qF "ERROR:  $message" "$log"; then
    if [[ "$(snapshot "$url" "$snap_sql")" == "$before" && "$(q "$url" "$SCHEMA_FP_SQL")" == "$fp_before" ]]; then
      pass "$label"
    else
      fail "$label (stopped, but data or schema changed)"
    fi
  else
    fail "$label (failed for an unexpected reason):"
    sed 's/^/        /' "$log" | tail -n 20
  fi
}

# lock_timeout: another session holds a lock on Document (as a long report query would). The file must give up after
# about 5 seconds instead of waiting (and making every later query on Document queue behind its ALTER TABLE).
new_seed_copy
PGAPPNAME="$BLOCKER_APP" psql "$NEG_URL" -X -q -v ON_ERROR_STOP=1 \
  -c 'BEGIN' -c 'LOCK TABLE "Document" IN ACCESS SHARE MODE' -c 'SELECT pg_sleep(300)' -c 'COMMIT' >/dev/null 2>&1 &
BLOCKER_PID=$!
LOCK_HELD=0
for _ in $(seq 1 100); do
  if [[ "$(q "$NEG_URL" "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE a.application_name = '$BLOCKER_APP' AND l.relation = '\"Document\"'::regclass AND l.granted")" == "1" ]]; then
    LOCK_HELD=1
    break
  fi
  sleep 0.1
done
if [[ "$LOCK_HELD" == "1" ]]; then
  LOCK_STARTED=$SECONDS
  expect_rollback "$NEG_URL" "Phase 3 SQL gives up on a locked Document table (\"lock timeout\"), nothing changed" \
    "$PHASE3_SQL" "canceling statement due to lock timeout"
  LOCK_ELAPSED=$((SECONDS - LOCK_STARTED))
  if [[ $LOCK_ELAPSED -ge 4 && $LOCK_ELAPSED -le 60 ]]; then
    pass "it waited about lock_timeout (${LOCK_ELAPSED}s), not until the other session ended"
  else
    fail "it took ${LOCK_ELAPSED}s on a locked Document table (expected about 5s)"
  fi
else
  fail "could not take a lock on Document in a second session"
fi
stop_blocker

# Copies of the file with one deliberate bug each: the self-check (or, for the last one, Postgres) must stop them.
mutate "$PHASE3_SQL" "$WORK/mutant-dupkeys.sql" \
  'IF NOT pg_temp.raqib_phase3_has_duplicate_keys(body::json) THEN' 'IF true THEN'
new_seed_copy
expect_rollback "$NEG_URL" "self-check stops a file whose duplicate-key check is skipped (keys lost by jsonb), nothing changed" \
  "$WORK/mutant-dupkeys.sql" "Phase 3 self-check failed: 2 legacy document(s) not moved exactly"
mutate "$PHASE3_SQL" "$WORK/mutant-firstmarker.sql" \
  "length(\"parsedText\") - strpos(reverse(\"parsedText\"), reverse('---AI_ANALYSIS---')) - length('---AI_ANALYSIS---') + 2" \
  "strpos(\"parsedText\", '---AI_ANALYSIS---')"
new_seed_copy
expect_rollback "$NEG_URL" "self-check stops a file that splits at the first marker, nothing changed" \
  "$WORK/mutant-firstmarker.sql" "Phase 3 self-check failed: 2 legacy document(s) not split at the last ---AI_ANALYSIS--- marker"
mutate "$PHASE3_SQL" "$WORK/mutant-transcripts.sql" 'SET "qualitativeSource" = true' 'SET "qualitativeSource" = false'
new_seed_copy
expect_rollback "$NEG_URL" "self-check stops a file that does not mark the old transcripts, nothing changed" \
  "$WORK/mutant-transcripts.sql" "Phase 3 self-check failed: 2 document(s) with a wrong qualitativeSource"
# Without its exception handler the duplicate-key check runs out of stack on the deeply nested fixture: proves that
# p3v-doc-deep exercises that path on this server, and that such an error rolls everything back.
mutate "$PHASE3_SQL" "$WORK/mutant-nohandler.sql" '    EXCEPTION WHEN OTHERS THEN' '    EXCEPTION WHEN division_by_zero THEN'
new_seed_copy
expect_rollback "$NEG_URL" "without its exception handler the deeply nested legacy JSON aborts the run (stack depth), nothing changed" \
  "$WORK/mutant-nohandler.sql" "stack depth limit exceeded"

run_quiet "Phase 3 SQL applied with psql -v ON_ERROR_STOP=1" \
  psql "$SEED_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE3_SQL"

section "3d. Checks after the Phase 3 SQL"
snapshot "$S" "$SNAP3_SQL" >"$WORK/after3.txt"
if diff -u "$WORK/before3.txt" "$WORK/after3.txt" >"$WORK/snapshot3.diff"; then
  pass "row counts and checksums unchanged for all $TABLES3 tables (every column; Document without parsedText)"
else
  fail "row counts or checksums changed:"
  sed 's/^/        /' "$WORK/snapshot3.diff"
fi

# Schema of AiCall, exactly as prisma/schema.prisma defines it (the drift check below compares it with Prisma too).
expect_eq "$S" "AiCall columns, types, nullability and defaults" \
  'id text not null, feature text not null, model text not null, servedModel text null, promptVersion text not null, systemPromptVersion text null, status AiCallStatus not null, stopReason text null, errorType text null, attempts int4 not null default 1, inputTokens int4 not null default 0, outputTokens int4 not null default 0, cacheReadTokens int4 not null default 0, cacheWriteTokens int4 not null default 0, latencyMs int4 not null, estimatedCostUsd numeric(12,6) null, organizationId text null, projectId text null, createdAt timestamp(3) not null default CURRENT_TIMESTAMP' \
  "SELECT string_agg(column_name || ' ' ||
            CASE WHEN data_type = 'USER-DEFINED' THEN udt_name
                 WHEN data_type = 'numeric' THEN 'numeric(' || numeric_precision || ',' || numeric_scale || ')'
                 WHEN data_type LIKE 'timestamp%' THEN udt_name || '(' || datetime_precision || ')'
                 ELSE udt_name END || ' ' ||
            CASE is_nullable WHEN 'NO' THEN 'not null' ELSE 'null' END || coalesce(' default ' || column_default, ''),
          ', ' ORDER BY ordinal_position)
   FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'AiCall'"
expect_eq "$S" "AiCallStatus enum values in order" "success,refusal,max_tokens,invalid_output,error" \
  "SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'AiCallStatus' AND t.typnamespace = 'public'::regnamespace"
expect_eq "$S" "AiCall indexes: primary key on id and the four Prisma-named indexes (projectId, createdAt included)" \
  'AiCall_createdAt_idx:btree ("createdAt"), AiCall_feature_createdAt_idx:btree (feature, "createdAt"), AiCall_organizationId_createdAt_idx:btree ("organizationId", "createdAt"), AiCall_pkey:unique btree (id), AiCall_projectId_createdAt_idx:btree ("projectId", "createdAt")' \
  "SELECT string_agg(indexname || ':' || CASE WHEN indexdef LIKE 'CREATE UNIQUE%' THEN 'unique ' ELSE '' END || regexp_replace(indexdef, '^.* USING ', ''), ', ' ORDER BY indexname)
   FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'AiCall'"
expect_eq "$S" "AiCall foreign keys to Organization and Project: ON DELETE SET NULL, ON UPDATE CASCADE" \
  'AiCall_organizationId_fkey:FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON UPDATE CASCADE ON DELETE SET NULL, AiCall_projectId_fkey:FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON UPDATE CASCADE ON DELETE SET NULL' \
  "SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), ', ' ORDER BY conname) FROM pg_constraint
   WHERE conrelid = 'public.\"AiCall\"'::regclass AND contype = 'f'"
expect_eq "$S" "row level security enabled on AiCall, with no policies (not readable with the anon key)" "true|0" \
  "SELECT relrowsecurity || '|' || (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) FROM pg_class c WHERE c.oid = 'public.\"AiCall\"'::regclass"
expect_eq "$S" "Document.aiAnalysis exists: jsonb, nullable, no default" "jsonb|YES|" \
  "SELECT data_type || '|' || is_nullable || '|' || coalesce(column_default, '') FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'Document' AND column_name = 'aiAnalysis'"
expect_eq "$S" "Document.qualitativeSource (boolean, not null, default false), Framework.generationError and IndicatorLibraryEntry.embeddingModel (text, nullable, no default)" \
  "Document.qualitativeSource:boolean:NO:false, Framework.generationError:text:YES:, IndicatorLibraryEntry.embeddingModel:text:YES:" \
  "SELECT string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ', ' ORDER BY table_name, column_name)
   FROM information_schema.columns WHERE table_schema = 'public'
     AND table_name || '.' || column_name IN ('Document.qualitativeSource', 'Framework.generationError', 'IndicatorLibraryEntry.embeddingModel')"
expect_zero "$S" "no generationError or embeddingModel invented for existing frameworks and library entries" \
  'SELECT (SELECT count(*) FROM "Framework" WHERE "generationError" IS NOT NULL) + (SELECT count(*) FROM "IndicatorLibraryEntry" WHERE "embeddingModel" IS NOT NULL)'
expect_zero "$S" "no AiCall rows invented by the migration" 'SELECT count(*) FROM "AiCall"'
expect_zero "$S" "the migration's pg_temp helpers and temp table did not outlive its session" \
  "SELECT (SELECT count(*) FROM pg_proc WHERE proname LIKE 'raqib\\_phase3\\_%') + (SELECT count(*) FROM pg_class WHERE relname LIKE 'raqib\\_phase3\\_%')"

# Foreign key behaviour, in a transaction that is rolled back: renaming an organisation follows into AiCall, deleting a
# project or an organisation keeps the call with an empty link. Synthetic organisation and project.
cat >"$WORK/fk.sql" <<'SQL'
BEGIN;
INSERT INTO "Organization" (id, name, type, country, city, "contactEmail")
VALUES ('p3v-org', 'Verify organisation (fixture)', 'local_ngo', 'Palestine', 'Hebron', 'verify@example.org');
INSERT INTO "Project" (id, "organizationId", name, sector, donor, "donorType", "startDate", "endDate")
VALUES ('p3v-prj', 'p3v-org', 'Verify project (fixture)', 'livelihoods', 'Verify donor', 'eu', '2026-01-01', '2026-12-31');
INSERT INTO "AiCall" (id, feature, model, "promptVersion", status, "latencyMs", "organizationId", "projectId")
VALUES ('p3v-call', 'verify.fk', 'claude-haiku-5-5', 'verify-v1', 'success', 1, 'p3v-org', 'p3v-prj');
UPDATE "Organization" SET id = 'p3v-org-renamed' WHERE id = 'p3v-org';
SELECT 'renamed:' || "organizationId" FROM "AiCall" WHERE id = 'p3v-call';
DELETE FROM "Project" WHERE id = 'p3v-prj';
SELECT 'project deleted:' || coalesce("organizationId", '-') || ',' || coalesce("projectId", '-') FROM "AiCall" WHERE id = 'p3v-call';
DELETE FROM "Organization" WHERE id = 'p3v-org-renamed';
SELECT 'organisation deleted:' || coalesce("organizationId", '-') || ',' || coalesce("projectId", '-') || ',' || attempts || ',' || "inputTokens" || ',' || ("createdAt" IS NOT NULL) FROM "AiCall" WHERE id = 'p3v-call';
ROLLBACK;
SQL
FK_OUT="$(psql "$S" -X -At -q -v ON_ERROR_STOP=1 -f "$WORK/fk.sql" 2>&1 | tr '\n' ';')" || true
FK_EXPECTED="renamed:p3v-org-renamed;project deleted:p3v-org-renamed,-;organisation deleted:-,-,1,0,true;"
if [[ "$FK_OUT" == "$FK_EXPECTED" ]]; then
  pass "AiCall foreign keys behave: organisation rename cascades, project and organisation deletes set the link to NULL, defaults applied"
else
  fail "AiCall foreign key behaviour (expected '$FK_EXPECTED', got '$FK_OUT')"
fi

# The legacy analysis move, document by document (fixtures from section 3).
expect_eq "$S" "only a document whose own text quotes the marker still contains it (was $LEGACY_DOCS documents)" "p3v-doc-twice" \
  "SELECT coalesce(string_agg(id, ',' ORDER BY id), 'none') FROM \"Document\" WHERE strpos(\"parsedText\", '---AI_ANALYSIS---') > 0"
expect_eq "$S" "transcripts of the old qualitative upload marked qualitativeSource, nothing else" "p3v-doc-kii,p3v-doc-transcript" \
  "SELECT coalesce(string_agg(id, ',' ORDER BY id), 'none') FROM \"Document\" WHERE \"qualitativeSource\""
# The post-deploy marking from docs/DATA_MODEL.md §9 step 8 (keep the statement in sync): it marks a transcript that
# the old API uploaded after the SQL ran, and nothing else (rolled back).
cat >"$WORK/window.sql" <<'SQL'
BEGIN;
INSERT INTO "Document" (id, "projectId", "uploadedBy", "fileName", "fileUrl", "fileType", "parsedText", "parsingStatus")
SELECT 'p3v-doc-window', "projectId", "uploadedBy", 'window.pdf', 'documents/verify/window.pdf', 'other', 'Window transcript.', 'completed'
FROM "Document" WHERE id = 'p3v-doc-plain';
INSERT INTO "QualitativeEntry" (id, "projectId", "entryType", title, content, attachments)
SELECT 'p3v-qe-window', "projectId", 'fgd_transcript', 'Window', 'Window transcript.', '[{"documentId":"p3v-doc-window","fileName":"window.pdf"}]'
FROM "Document" WHERE id = 'p3v-doc-window';
WITH marked AS (
  UPDATE "Document" d SET "qualitativeSource" = true
  WHERE NOT d."qualitativeSource" AND EXISTS (
    SELECT 1 FROM "QualitativeEntry" q
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(q."attachments") = 'array' THEN q."attachments" ELSE '[]'::jsonb END) AS a(item)
    WHERE q."projectId" = d."projectId" AND jsonb_typeof(a.item) = 'object' AND a.item -> 'documentId' = to_jsonb(d."id"))
  RETURNING d.id)
SELECT 'marked:' || coalesce(string_agg(id, ',' ORDER BY id), 'none') FROM marked;
ROLLBACK;
SQL
WINDOW_OUT="$(psql "$S" -X -At -q -v ON_ERROR_STOP=1 -f "$WORK/window.sql" 2>&1)" || true
if [[ "$WINDOW_OUT" == "marked:p3v-doc-window" ]]; then
  pass "the post-deploy transcript marking (DATA_MODEL §9 step 8) marks only a transcript uploaded in the window (rolled back)"
else
  fail "post-deploy transcript marking (expected 'marked:p3v-doc-window', got '$WINDOW_OUT')"
fi

cat >"$WORK/documents-expected.sql" <<'SQL'
SELECT e.label,
       (d.id IS NOT NULL AND d."parsedText" IS NOT DISTINCT FROM e.pt AND d."aiAnalysis" IS NOT DISTINCT FROM e.ai
        AND d."qualitativeSource" = e.qs)::text,
       e.id
FROM (VALUES
  ('p3v-doc-json', 'valid JSON after the marker moved to aiAnalysis as JSON (snake_case keys kept); parsedText is the text before it',
   'Livelihoods proposal for Hebron. Baseline: 41% of households have acceptable FCS (2025 survey).',
   '{"document_type":"proposal","summary":"Livelihoods proposal.","key_findings":["Baseline FCS 41%"],"indicators_mentioned":["% of households with acceptable FCS"],"targets_mentioned":[{"indicator":"FCS","target":"60%","timeline":"2027"}],"recommendations":["Add sex disaggregation"]}'::jsonb,
   false),
  ('p3v-doc-bad', 'invalid JSON (answer cut off) moved as {legacyText} verbatim',
   'Baseline report text.', jsonb_build_object('legacyText', '{"summary": "Answer cut off at max_tok'), false),
  ('p3v-doc-plain', 'document without the marker untouched (trailing whitespace kept), no aiAnalysis; an entry whose attachments are an object does not mark it',
   E'Plain text without an analysis.\n\n', NULL::jsonb, false),
  ('p3v-doc-null', 'document without parsed text untouched, no aiAnalysis', NULL, NULL, false),
  ('p3v-doc-like', 'marker look-alikes (---AIXANALYSIS---, LIKE wildcard trap) untouched, no aiAnalysis; a bare string in attachments does not mark it',
   'Text with ---AIXANALYSIS--- and ---AI ANALYSIS--- look-alikes.', NULL, false),
  ('p3v-doc-array', 'valid JSON that is not an object (array) moved as {legacyText}',
   'Budget lines.', jsonb_build_object('legacyText', '["not", "an", "object"]'), false),
  ('p3v-doc-dup', 'JSON with a duplicate key moved as {legacyText} (jsonb would drop the first value)',
   'Logframe.', jsonb_build_object('legacyText', '{"summary":"first","summary":"second"}'), false),
  ('p3v-doc-dupnested', 'JSON with a duplicate key deep inside moved as {legacyText}',
   'Logframe v2.', jsonb_build_object('legacyText', '{"summary":"ok","targets_mentioned":[{"target":"60%","target":"70%"}]}'), false),
  ('p3v-doc-twice', 'two markers: split at the LAST (as the readers do); the marker quoted by the document stays in its text, the appended JSON moves',
   'Guidelines quoting ---AI_ANALYSIS--- in the text.', '{"summary":"s"}'::jsonb, false),
  ('p3v-doc-quoteonly', 'one marker quoted by a document that got no analysis: the text after it moves as {legacyText}, as the readers treat it (nothing lost)',
   'A note that quotes', jsonb_build_object('legacyText', 'but got no analysis.'), false),
  ('p3v-doc-overlap', 'overlapping markers (---AI_ANALYSIS---AI_ANALYSIS---): split where the last one starts, as lastIndexOf does',
   E'Overlap.\n\n---AI_ANALYSIS', '{"summary":"overlap"}'::jsonb, false),
  ('p3v-doc-deep', 'JSON nested 600 levels deep (too deep for the duplicate-key check) moved as {legacyText} instead of aborting the run',
   'Deep.', jsonb_build_object('legacyText', '{"a":' || repeat('[', 600) || '1' || repeat(']', 600) || '}'), false),
  ('p3v-doc-empty', 'only whitespace after the marker: parsedText is the text before it, aiAnalysis stays empty',
   'Text only.', NULL, false),
  ('p3v-doc-arabic', 'Arabic text and Arabic JSON moved intact',
   'مقترح مشروع سبل العيش في الخليل.', '{"summary":"ملخص المقترح","keyFindings":["نسبة الأسر ٤١٪"]}'::jsonb, false),
  ('p3v-doc-only', 'marker at the very start: parsedText becomes empty, the analysis moves',
   '', '{"summary":"only the analysis"}'::jsonb, false),
  ('p3v-doc-nul', 'JSON that jsonb cannot store (\u0000) moved as {legacyText}',
   'Text.', jsonb_build_object('legacyText', '{"summary":"a\u0000b"}'), false),
  ('p3v-doc-crlf', 'CRLF line ends: trailing spaces, tabs and CR/LF trimmed from parsedText, JSON moved',
   'Survey text', '{"summary":"crlf"}'::jsonb, false),
  ('p3v-doc-transcript', 'transcript of the old qualitative upload (attached to an entry of its project): qualitativeSource, its analysis moved',
   'Participant 3 said the water point is far.', '{"summary":"FGD on water access."}'::jsonb, true),
  ('p3v-doc-kii', 'document attached as the second item of an entry''s attachments: qualitativeSource, text untouched',
   'KII notes: the clinic opens twice a week.', NULL, true),
  ('p3v-doc-transcript2', 'document attached only to an entry of ANOTHER project: not marked',
   'Transcript attached from another project''s entry.', NULL, false)
) AS e(id, label, pt, ai, qs)
LEFT JOIN "Document" d ON d.id = e.id
ORDER BY e.id;
SQL
DOC_ROWS="$(psql "$S" -X -At -F $'\t' -v ON_ERROR_STOP=1 -f "$WORK/documents-expected.sql" 2>&1)" \
  || { fail "document expectations query failed: $DOC_ROWS"; DOC_ROWS=""; }
while IFS=$'\t' read -r label ok id; do
  [[ -n "$label" ]] || continue
  if [[ "$ok" == "true" ]]; then
    pass "$label"
  else
    fail "$label ($id is now: $(q "$S" "SELECT coalesce(quote_literal(\"parsedText\"), 'NULL') || ' / ' || coalesce(\"aiAnalysis\"::text, 'NULL') FROM \"Document\" WHERE id = '$id'"))"
  fi
done <<<"$DOC_ROWS"

# The same rules for every document, from the saved old parsedText values (seed documents included).
cat >"$WORK/documents-before.sql" <<SQL
CREATE TEMP TABLE before_docs (id text PRIMARY KEY, pt text);
\\copy before_docs FROM '$WORK/documents-before.csv' WITH (FORMAT csv)
SQL
expect_before() {
  local label="$1" sql="$2" n
  n="$(psql "$S" -X -At -q -v ON_ERROR_STOP=1 -f "$WORK/documents-before.sql" -c "$sql" 2>&1)" \
    || { fail "$label (query error: $n)"; return 0; }
  if [[ "$n" == "0" ]]; then pass "$label"; else fail "$label (found $n)"; fi
}
expect_before "every document without the marker kept its parsedText exactly and has no aiAnalysis" \
  "SELECT count(*) FROM before_docs b LEFT JOIN \"Document\" d ON d.id = b.id
   WHERE coalesce(strpos(b.pt, '---AI_ANALYSIS---'), 0) = 0
     AND (d.id IS NULL OR d.\"parsedText\" IS DISTINCT FROM b.pt OR d.\"aiAnalysis\" IS NOT NULL)"
# The last marker is found here with a greedy regular expression (everything up to and including the last marker),
# independently of the reverse() arithmetic in the SQL file.
expect_before "nothing lost: for every legacy document, the old parsedText is the new parsedText + whitespace + the LAST marker + the text kept in aiAnalysis" \
  "SELECT count(*) FROM before_docs b
   CROSS JOIN LATERAL (SELECT regexp_replace(b.pt, '^.*---AI_ANALYSIS---', '') AS tail) m
   LEFT JOIN \"Document\" d ON d.id = b.id
   CROSS JOIN LATERAL (SELECT left(b.pt, length(b.pt) - length(m.tail) - 17) AS head, btrim(m.tail, E' \\t\\r\\n\\f\\x0B') AS body) t
   WHERE strpos(b.pt, '---AI_ANALYSIS---') > 0
     AND (d.id IS NULL
          OR left(t.head, length(d.\"parsedText\")) <> d.\"parsedText\"
          OR btrim(substr(t.head, length(d.\"parsedText\") + 1), E' \\t\\r\\n\\f\\x0B') <> ''
          OR NOT CASE WHEN t.body = '' THEN d.\"aiAnalysis\" IS NULL
                      WHEN d.\"aiAnalysis\" IS NULL THEN false
                      WHEN d.\"aiAnalysis\" ? 'legacyText' THEN d.\"aiAnalysis\" = jsonb_build_object('legacyText', t.body)
                      ELSE d.\"aiAnalysis\" = t.body::jsonb END)"
expect_before "the document count is unchanged" \
  "SELECT abs((SELECT count(*) FROM before_docs) - (SELECT count(*) FROM \"Document\"))"

check_no_drift "$S" "no drift between the database after the Phase 3 SQL and the Phase 3 schema ($PHASE3_REV)" "$PHASE3_SCHEMA"
run_quiet "the app's Prisma client creates, reads and deletes AiCall rows and reads the moved analyses (seed copy)" \
  in_dir "$ROOT" env EXPECT_LEGACY_DOCS=1 DATABASE_URL="$SEED_URL" DIRECT_URL="$SEED_URL" "$TSX" "$WORK/aicall-check.ts"
run_quiet "the app's Prisma client still reads indicators with results, projects with sectors, result nodes" \
  in_dir "$ROOT" env DATABASE_URL="$SEED_URL" DIRECT_URL="$SEED_URL" "$TSX" "$WORK/read-check.ts"

# Running the file a second time must be refused and change nothing (every column of every table, new ones included).
SNAP_ALL_SQL="$WORK/snapshot-all.sql"
build_snapshot_sql "$S" "$SNAP_ALL_SQL"
expect_refused "$S" "second Phase 3 run refused (\"already applied\") and nothing changed" \
  "$PHASE3_SQL" "Phase 3 migration already applied" "$SNAP_ALL_SQL"

info "after the Phase 3 SQL: $(q "$S" 'SELECT count(*) FROM "Document" WHERE "aiAnalysis" IS NOT NULL') documents with aiAnalysis ($(q "$S" "SELECT count(*) FROM \"Document\" WHERE \"aiAnalysis\" ? 'legacyText'") as legacyText), AiCall rows: $(q "$S" 'SELECT count(*) FROM "AiCall"')"

# --- 3e/3f. Phase 4 on the same database ---------------------------------------------------------------------------

section "3e. Phase 4 SQL (on the database after the Phase 3 SQL)"
# Snapshot of every column of every table as it is after Phase 3. Phase 4 changes none of them, so the same snapshot is
# compared after it (3f) and around every run that must roll back.
SNAP4_SQL="$WORK/snapshot4.sql"
build_snapshot_sql "$S" "$SNAP4_SQL"
snapshot "$S" "$SNAP4_SQL" >"$WORK/before4.txt"
TABLES4="$(wc -l <"$WORK/before4.txt" | tr -d ' ')"
info "snapshot of $TABLES4 tables (row count + md5 of every column)"

# lock_timeout: another session has an open write transaction on Framework (ROW EXCLUSIVE, which every INSERT, UPDATE
# and DELETE takes). Creating KpiSuggestionRun_frameworkId_fkey needs SHARE ROW EXCLUSIVE on Framework, which conflicts
# with it, so the file must give up after about 5 seconds instead of waiting (and making every later write to Framework
# queue behind it). A plain read (ACCESS SHARE) does not conflict with SHARE ROW EXCLUSIVE: reads carry on meanwhile.
new_seed_copy
PGAPPNAME="$BLOCKER_APP" psql "$NEG_URL" -X -q -v ON_ERROR_STOP=1 \
  -c 'BEGIN' -c 'LOCK TABLE "Framework" IN ROW EXCLUSIVE MODE' -c 'SELECT pg_sleep(300)' -c 'COMMIT' >/dev/null 2>&1 &
BLOCKER_PID=$!
LOCK_HELD=0
for _ in $(seq 1 100); do
  if [[ "$(q "$NEG_URL" "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE a.application_name = '$BLOCKER_APP' AND l.relation = '\"Framework\"'::regclass AND l.mode = 'RowExclusiveLock' AND l.granted")" == "1" ]]; then
    LOCK_HELD=1
    break
  fi
  sleep 0.1
done
if [[ "$LOCK_HELD" == "1" ]]; then
  LOCK_STARTED=$SECONDS
  expect_rollback "$NEG_URL" "Phase 4 SQL gives up while another session writes to Framework (\"lock timeout\"), nothing changed" \
    "$PHASE4_SQL" "canceling statement due to lock timeout" "$SNAP4_SQL"
  LOCK_ELAPSED=$((SECONDS - LOCK_STARTED))
  if [[ $LOCK_ELAPSED -ge 4 && $LOCK_ELAPSED -le 60 ]]; then
    pass "it waited about lock_timeout (${LOCK_ELAPSED}s), not until the other session ended"
  else
    fail "it took ${LOCK_ELAPSED}s on a Framework table with an open write transaction (expected about 5s)"
  fi
else
  fail "could not take a write lock on Framework in a second session"
fi
stop_blocker

# Copies of the file with one deliberate bug each: its self-check must stop them.
mutate "$PHASE4_SQL" "$WORK/mutant4-rls.sql" \
  'ALTER TABLE "KpiSuggestion" ENABLE ROW LEVEL SECURITY;' '-- (mutant: row level security not enabled on KpiSuggestion)'
new_seed_copy
expect_rollback "$NEG_URL" "self-check stops a file that leaves row level security off on KpiSuggestion, nothing changed" \
  "$WORK/mutant4-rls.sql" "Phase 4 self-check failed: row level security is not enabled on KpiSuggestion" "$SNAP4_SQL"
mutate "$PHASE4_SQL" "$WORK/mutant4-cascade.sql" \
  '"KpiSuggestion_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ResultNode"("id") ON DELETE SET NULL' \
  '"KpiSuggestion_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ResultNode"("id") ON DELETE CASCADE'
new_seed_copy
expect_rollback "$NEG_URL" "self-check stops a file whose KpiSuggestion.resultId cascades on delete (feedback would be lost), nothing changed" \
  "$WORK/mutant4-cascade.sql" "Phase 4 self-check failed: foreign key(s) missing, extra or with the wrong target or behaviour: KpiSuggestion_resultId_fkey" "$SNAP4_SQL"
mutate "$PHASE4_SQL" "$WORK/mutant4-enum.sql" \
  "CREATE TYPE \"SuggestionStatus\" AS ENUM ('pending', 'accepted', 'edited_accepted', 'rejected', 'expired');" \
  "CREATE TYPE \"SuggestionStatus\" AS ENUM ('pending', 'accepted', 'rejected', 'expired');"
new_seed_copy
expect_rollback "$NEG_URL" "self-check stops a file with a SuggestionStatus value missing, nothing changed" \
  "$WORK/mutant4-enum.sql" "Phase 4 self-check failed: enum labels differ: SuggestionStatus is [pending,accepted,rejected,expired], expected [pending,accepted,edited_accepted,rejected,expired]" "$SNAP4_SQL"

run_quiet "Phase 4 SQL applied with psql -v ON_ERROR_STOP=1" \
  psql "$SEED_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE4_SQL"

section "3f. Checks after the Phase 4 SQL"
snapshot "$S" "$SNAP4_SQL" >"$WORK/after4.txt"
if diff -u "$WORK/before4.txt" "$WORK/after4.txt" >"$WORK/snapshot4.diff"; then
  pass "row counts and checksums unchanged for all $TABLES4 pre-existing tables (every column)"
else
  fail "row counts or checksums changed:"
  sed 's/^/        /' "$WORK/snapshot4.diff"
fi

# Both tables exactly as prisma/schema.prisma defines them (the drift check below compares them with Prisma too).
COLUMNS_SQL="SELECT string_agg(column_name || ' ' ||
            CASE WHEN data_type = 'USER-DEFINED' THEN udt_name
                 WHEN data_type = 'numeric' THEN 'numeric(' || numeric_precision || ',' || numeric_scale || ')'
                 WHEN data_type LIKE 'timestamp%' THEN udt_name || '(' || datetime_precision || ')'
                 ELSE udt_name END || ' ' ||
            CASE is_nullable WHEN 'NO' THEN 'not null' ELSE 'null' END || coalesce(' default ' || column_default, ''),
          ', ' ORDER BY ordinal_position)
   FROM information_schema.columns WHERE table_schema = 'public' AND table_name = "
KPI_RUN_COLUMNS="$(cat <<'TXT'
id text not null, projectId text not null, frameworkId text not null, scope KpiRunScope not null, resultId text null, sourceIndicatorId text null, sourceSuggestionId text null, status KpiRunStatus not null default 'running'::"KpiRunStatus", step text not null default 'context'::text, errorCode text null, error text null, frameworkWarnings jsonb not null default '[]'::jsonb, suggestionCount int4 not null default 0, retrieval text null, model text null, promptVersion text null, modelCalls int4 not null default 0, embeddingCalls int4 not null default 0, inputTokens int4 not null default 0, outputTokens int4 not null default 0, estimatedCostUsd numeric(12,6) null, latencyMs int4 null, requestedBy text null, createdAt timestamp(3) not null default CURRENT_TIMESTAMP, updatedAt timestamp(3) not null, finishedAt timestamp(3) null
TXT
)"
KPI_SUGGESTION_COLUMNS="$(cat <<'TXT'
id text not null, projectId text not null, frameworkId text not null, runId text not null, resultId text null, level IndicatorLevel not null, sortOrder int4 not null default 0, payload jsonb not null, qualityScore int4 not null, warnings jsonb not null default '[]'::jsonb, libraryId text null, isCustom bool not null default false, method CollectionMethod not null, alternativeOfIndicatorId text null, alternativeOfSuggestionId text null, status SuggestionStatus not null default 'pending'::"SuggestionStatus", model text not null, promptVersion text not null, createdAt timestamp(3) not null default CURRENT_TIMESTAMP, decidedAt timestamp(3) null, decidedBy text null, rejectReason SuggestionRejectReason null, rejectNote text null, indicatorId text null
TXT
)"
expect_eq "$S" "KpiSuggestionRun columns, types, nullability and defaults (updatedAt without a database default)" \
  "$KPI_RUN_COLUMNS" "$COLUMNS_SQL'KpiSuggestionRun'"
expect_eq "$S" "KpiSuggestion columns, types, nullability and defaults" \
  "$KPI_SUGGESTION_COLUMNS" "$COLUMNS_SQL'KpiSuggestion'"
expect_eq "$S" "the four Phase 4 enums with their values in order" \
  "KpiRunScope:framework,result,alternatives; KpiRunStatus:running,completed,failed; SuggestionRejectReason:not_relevant,too_costly_to_measure,donor_not_required,duplicate,wording,other; SuggestionStatus:pending,accepted,edited_accepted,rejected,expired" \
  "SELECT string_agg(typname || ':' || labels, '; ' ORDER BY typname) FROM (
     SELECT t.typname::text AS typname, string_agg(e.enumlabel::text, ',' ORDER BY e.enumsortorder) AS labels
     FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typnamespace = 'public'::regnamespace AND t.typname IN ('SuggestionStatus', 'SuggestionRejectReason', 'KpiRunScope', 'KpiRunStatus')
     GROUP BY t.typname) s"
INDEXES_SQL="SELECT string_agg(indexname || ':' || CASE WHEN indexdef LIKE 'CREATE UNIQUE%' THEN 'unique ' ELSE '' END || regexp_replace(indexdef, '^.* USING ', ''), ', ' ORDER BY indexname)
   FROM pg_indexes WHERE schemaname = 'public' AND tablename = "
expect_eq "$S" "KpiSuggestionRun indexes: primary key and the two Prisma-named indexes" \
  'KpiSuggestionRun_frameworkId_status_idx:btree ("frameworkId", status), KpiSuggestionRun_pkey:unique btree (id), KpiSuggestionRun_projectId_createdAt_idx:btree ("projectId", "createdAt")' \
  "$INDEXES_SQL'KpiSuggestionRun'"
expect_eq "$S" "KpiSuggestion indexes: primary key, unique indicatorId and the five Prisma-named indexes" \
  'KpiSuggestion_frameworkId_status_idx:btree ("frameworkId", status), KpiSuggestion_indicatorId_key:unique btree ("indicatorId"), KpiSuggestion_libraryId_status_idx:btree ("libraryId", status), KpiSuggestion_pkey:unique btree (id), KpiSuggestion_projectId_status_idx:btree ("projectId", status), KpiSuggestion_resultId_idx:btree ("resultId"), KpiSuggestion_runId_idx:btree ("runId")' \
  "$INDEXES_SQL'KpiSuggestion'"
FKEYS_SQL="SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), ', ' ORDER BY conname) FROM pg_constraint WHERE contype = 'f' AND conrelid = "
expect_eq "$S" "KpiSuggestionRun foreign keys: project and framework CASCADE, result and sources SET NULL, all ON UPDATE CASCADE" \
  'KpiSuggestionRun_frameworkId_fkey:FOREIGN KEY ("frameworkId") REFERENCES "Framework"(id) ON UPDATE CASCADE ON DELETE CASCADE, KpiSuggestionRun_projectId_fkey:FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON UPDATE CASCADE ON DELETE CASCADE, KpiSuggestionRun_resultId_fkey:FOREIGN KEY ("resultId") REFERENCES "ResultNode"(id) ON UPDATE CASCADE ON DELETE SET NULL, KpiSuggestionRun_sourceIndicatorId_fkey:FOREIGN KEY ("sourceIndicatorId") REFERENCES "Indicator"(id) ON UPDATE CASCADE ON DELETE SET NULL, KpiSuggestionRun_sourceSuggestionId_fkey:FOREIGN KEY ("sourceSuggestionId") REFERENCES "KpiSuggestion"(id) ON UPDATE CASCADE ON DELETE SET NULL' \
  "$FKEYS_SQL'public.\"KpiSuggestionRun\"'::regclass"
expect_eq "$S" "KpiSuggestion foreign keys: project and framework CASCADE, run NO ACTION, result, library, indicator and alternatives SET NULL" \
  'KpiSuggestion_alternativeOfIndicatorId_fkey:FOREIGN KEY ("alternativeOfIndicatorId") REFERENCES "Indicator"(id) ON UPDATE CASCADE ON DELETE SET NULL, KpiSuggestion_alternativeOfSuggestionId_fkey:FOREIGN KEY ("alternativeOfSuggestionId") REFERENCES "KpiSuggestion"(id) ON UPDATE CASCADE ON DELETE SET NULL, KpiSuggestion_frameworkId_fkey:FOREIGN KEY ("frameworkId") REFERENCES "Framework"(id) ON UPDATE CASCADE ON DELETE CASCADE, KpiSuggestion_indicatorId_fkey:FOREIGN KEY ("indicatorId") REFERENCES "Indicator"(id) ON UPDATE CASCADE ON DELETE SET NULL, KpiSuggestion_libraryId_fkey:FOREIGN KEY ("libraryId") REFERENCES "IndicatorLibraryEntry"(id) ON UPDATE CASCADE ON DELETE SET NULL, KpiSuggestion_projectId_fkey:FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON UPDATE CASCADE ON DELETE CASCADE, KpiSuggestion_resultId_fkey:FOREIGN KEY ("resultId") REFERENCES "ResultNode"(id) ON UPDATE CASCADE ON DELETE SET NULL, KpiSuggestion_runId_fkey:FOREIGN KEY ("runId") REFERENCES "KpiSuggestionRun"(id) ON UPDATE CASCADE' \
  "$FKEYS_SQL'public.\"KpiSuggestion\"'::regclass"
expect_eq "$S" "row level security enabled on KpiSuggestionRun and KpiSuggestion, with no policies (not readable with the anon key)" \
  "KpiSuggestion:true:0, KpiSuggestionRun:true:0" \
  "SELECT string_agg(c.relname || ':' || c.relrowsecurity || ':' || (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid), ', ' ORDER BY c.relname)
   FROM pg_class c WHERE c.oid IN ('public.\"KpiSuggestionRun\"'::regclass, 'public.\"KpiSuggestion\"'::regclass)"
expect_zero "$S" "no KPI rows invented by the migration" \
  'SELECT (SELECT count(*) FROM "KpiSuggestionRun") + (SELECT count(*) FROM "KpiSuggestion")'
expect_zero "$S" "the migration's temp table did not outlive its session" \
  "SELECT count(*) FROM pg_class WHERE relname LIKE 'raqib\\_phase4\\_%'"

# Foreign key behaviour on synthetic fixtures, in a transaction that is rolled back: defaults (raw inserts set "id" and
# "updatedAt", which have no database default), one suggestion per accepted indicator, an id rename that follows, a
# deleted result, library entry, indicator or source suggestion that empties the link (rejected suggestions stay as
# feedback), a run with suggestions that cannot be deleted, a project with a framework that cannot be deleted (the
# API archives projects instead), and a framework delete that removes its runs and suggestions in one statement (the
# NO ACTION check on runId runs at the end of that statement, when the suggestions are gone too).
cat >"$WORK/fk4.sql" <<'SQL'
BEGIN;
-- Runs a statement and says whether it ran or which constraint (foreign key or unique index) refused it; a refused
-- statement is rolled back on its own and the transaction carries on.
CREATE FUNCTION pg_temp.p4v_try(statement text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  refused_by text;
BEGIN
  EXECUTE statement;
  RETURN 'ran';
EXCEPTION WHEN foreign_key_violation OR unique_violation THEN
  GET STACKED DIAGNOSTICS refused_by = CONSTRAINT_NAME;
  RETURN 'refused by ' || refused_by;
END
$$;
INSERT INTO "Organization" (id, name, type, country, city, "contactEmail")
VALUES ('p4v-org', 'Verify organisation (fixture)', 'local_ngo', 'Palestine', 'Hebron', 'verify@example.org');
INSERT INTO "Project" (id, "organizationId", name, sector, donor, "donorType", "startDate", "endDate")
VALUES ('p4v-prj', 'p4v-org', 'Verify project (fixture)', 'wash', 'Verify donor', 'echo', '2026-01-01', '2026-12-31');
INSERT INTO "Framework" (id, "projectId", version) VALUES ('p4v-fw', 'p4v-prj', 1);
INSERT INTO "ResultNode" (id, "frameworkId", level, code, text)
VALUES ('p4v-o1', 'p4v-fw', 'outcome', 'O1', 'Verify outcome (fixture)'), ('p4v-o2', 'p4v-fw', 'outcome', 'O2', 'Verify outcome 2 (fixture)');
INSERT INTO "Indicator" (id, "frameworkId", "resultId", "indicatorText", level, "dataCollectionMethod", frequency, phases)
VALUES ('p4v-ind', 'p4v-fw', 'p4v-o2', 'Verify indicator (fixture)', 'outcome', 'hh_survey', 'quarterly', '[]');
INSERT INTO "IndicatorLibraryEntry" (id, sector, tags, level, name, "nameAr", definition, unit, direction, disaggregation,
                                     methods, frequency, "meansOfVerification", "isStandard", version, "updatedAt")
VALUES ('P4V-01', 'wash', '{}', 'outcome', 'Fixture entry', 'مؤشر تجريبي', 'Fixture.', 'number', 'increase', '{}', '{}',
        'quarterly', 'Fixture.', false, 'verify', now());
-- Raw inserts set "id" (no database default for @default(uuid())) and "updatedAt" (@updatedAt has no database default).
INSERT INTO "KpiSuggestionRun" (id, "projectId", "frameworkId", scope, "resultId", "sourceIndicatorId", "updatedAt")
VALUES ('p4v-run', 'p4v-prj', 'p4v-fw', 'alternatives', 'p4v-o1', 'p4v-ind', now());
INSERT INTO "KpiSuggestion" (id, "projectId", "frameworkId", "runId", "resultId", level, payload, "qualityScore", method, model,
                             "promptVersion", "libraryId", "alternativeOfIndicatorId")
VALUES ('p4v-s1', 'p4v-prj', 'p4v-fw', 'p4v-run', 'p4v-o1', 'outcome', '{"name":"Verify suggestion"}', 85, 'hh_survey',
        'claude-sonnet-5-5', 'kpi-v1', 'P4V-01', 'p4v-ind');
INSERT INTO "KpiSuggestion" (id, "projectId", "frameworkId", "runId", "resultId", level, payload, "qualityScore", method, model,
                             "promptVersion", status, "indicatorId", "decidedAt")
VALUES ('p4v-s2', 'p4v-prj', 'p4v-fw', 'p4v-run', 'p4v-o1', 'outcome', '{}', 100, 'observation', 'claude-sonnet-5-5', 'kpi-v1',
        'accepted', 'p4v-ind', now());
INSERT INTO "KpiSuggestionRun" (id, "projectId", "frameworkId", scope, "resultId", "sourceSuggestionId", status, "updatedAt")
VALUES ('p4v-run2', 'p4v-prj', 'p4v-fw', 'alternatives', 'p4v-o1', 'p4v-s1', 'completed', now());
INSERT INTO "KpiSuggestion" (id, "projectId", "frameworkId", "runId", "resultId", level, payload, "qualityScore", method, model,
                             "promptVersion", status, "rejectReason", "alternativeOfSuggestionId", "decidedAt")
VALUES ('p4v-s3', 'p4v-prj', 'p4v-fw', 'p4v-run2', 'p4v-o1', 'outcome', '{}', 70, 'kii', 'claude-haiku-5-5', 'kpi-v1',
        'rejected', 'not_relevant', 'p4v-s1', now());
SELECT 'run defaults:' || status::text || ',' || step || ',' || "frameworkWarnings"::text || ',' || "suggestionCount" || ',' || "modelCalls"
       || ',' || "embeddingCalls" || ',' || "inputTokens" || ',' || "outputTokens" || ',' || ("createdAt" IS NOT NULL)
FROM "KpiSuggestionRun" WHERE id = 'p4v-run';
SELECT 'suggestion defaults:' || status::text || ',' || "sortOrder" || ',' || warnings::text || ',' || "isCustom" FROM "KpiSuggestion" WHERE id = 'p4v-s1';
SELECT 'second accepted suggestion for one indicator:' || pg_temp.p4v_try($q$UPDATE "KpiSuggestion" SET "indicatorId" = 'p4v-ind' WHERE id = 'p4v-s3'$q$);
UPDATE "Project" SET id = 'p4v-prj2' WHERE id = 'p4v-prj';
SELECT 'project renamed:' || string_agg(DISTINCT "projectId", ',') FROM (SELECT "projectId" FROM "KpiSuggestionRun" WHERE id LIKE 'p4v-%'
                                                                       UNION ALL SELECT "projectId" FROM "KpiSuggestion" WHERE id LIKE 'p4v-%') x;
DELETE FROM "ResultNode" WHERE id = 'p4v-o1';
SELECT 'result deleted:' || count(*) FILTER (WHERE "resultId" IS NULL) || '/' || count(*) FROM (SELECT "resultId" FROM "KpiSuggestionRun" WHERE id LIKE 'p4v-%'
                                                         UNION ALL SELECT "resultId" FROM "KpiSuggestion" WHERE id LIKE 'p4v-%') x;
DELETE FROM "IndicatorLibraryEntry" WHERE id = 'P4V-01';
SELECT 'library entry deleted:' || coalesce("libraryId", '-') FROM "KpiSuggestion" WHERE id = 'p4v-s1';
DELETE FROM "Indicator" WHERE id = 'p4v-ind';
SELECT 'indicator deleted:' || coalesce((SELECT "sourceIndicatorId" FROM "KpiSuggestionRun" WHERE id = 'p4v-run'), '-') || ','
       || coalesce((SELECT "alternativeOfIndicatorId" FROM "KpiSuggestion" WHERE id = 'p4v-s1'), '-') || ','
       || (SELECT coalesce("indicatorId", '-') || ':' || status::text FROM "KpiSuggestion" WHERE id = 'p4v-s2');
DELETE FROM "KpiSuggestion" WHERE id = 'p4v-s1';
SELECT 'suggestion deleted:' || coalesce((SELECT "sourceSuggestionId" FROM "KpiSuggestionRun" WHERE id = 'p4v-run2'), '-') || ','
       || coalesce((SELECT "alternativeOfSuggestionId" FROM "KpiSuggestion" WHERE id = 'p4v-s3'), '-');
SELECT 'run with suggestions deleted:' || pg_temp.p4v_try($q$DELETE FROM "KpiSuggestionRun" WHERE id = 'p4v-run'$q$)
       || ',' || (SELECT count(*) FROM "KpiSuggestionRun" WHERE id LIKE 'p4v-%') || ',' || (SELECT count(*) FROM "KpiSuggestion" WHERE id LIKE 'p4v-%');
SELECT 'project with a framework deleted:' || pg_temp.p4v_try($q$DELETE FROM "Project" WHERE id = 'p4v-prj2'$q$);
DELETE FROM "Framework" WHERE id = 'p4v-fw';
SELECT 'framework deleted:' || (SELECT count(*) FROM "KpiSuggestionRun" WHERE id LIKE 'p4v-%') || ',' || (SELECT count(*) FROM "KpiSuggestion" WHERE id LIKE 'p4v-%')
       || ',' || (SELECT count(*) FROM "ResultNode" WHERE id LIKE 'p4v-%');
SELECT 'project deleted:' || pg_temp.p4v_try($q$DELETE FROM "Project" WHERE id = 'p4v-prj2'$q$);
ROLLBACK;
SQL
FK4_OUT="$(psql "$S" -X -At -q -v ON_ERROR_STOP=1 -f "$WORK/fk4.sql" 2>&1 | tr '\n' ';')" || true
FK4_EXPECTED="run defaults:running,context,[],0,0,0,0,0,true;suggestion defaults:pending,0,[],false;second accepted suggestion for one indicator:refused by KpiSuggestion_indicatorId_key;project renamed:p4v-prj2;result deleted:5/5;library entry deleted:-;indicator deleted:-,-,-:accepted;suggestion deleted:-,-;run with suggestions deleted:refused by KpiSuggestion_runId_fkey,2,2;project with a framework deleted:refused by Framework_projectId_fkey;framework deleted:0,0,0;project deleted:ran;"
if [[ "$FK4_OUT" == "$FK4_EXPECTED" ]]; then
  pass "KPI foreign keys behave: defaults, unique indicatorId, renames follow, SET NULL on result/library/indicator/suggestion deletes, a run with suggestions and a project with a framework cannot be deleted, a framework delete removes its runs and suggestions (rolled back)"
else
  fail "KPI foreign key behaviour (expected '$FK4_EXPECTED', got '$FK4_OUT')"
fi

check_no_drift "$S" "no drift between the database after the Phase 4 SQL and prisma/schema.prisma"
run_quiet "the app's Prisma client writes, reads and deletes KPI runs and suggestions (seed copy)" \
  in_dir "$ROOT" env DATABASE_URL="$SEED_URL" DIRECT_URL="$SEED_URL" "$TSX" "$WORK/kpi-check.ts"
run_quiet "the app's Prisma client still creates and reads AiCall rows and reads the moved analyses after Phase 4" \
  in_dir "$ROOT" env EXPECT_LEGACY_DOCS=1 DATABASE_URL="$SEED_URL" DIRECT_URL="$SEED_URL" "$TSX" "$WORK/aicall-check.ts"
run_quiet "the app's Prisma client still reads indicators with results, projects with sectors, result nodes after Phase 4" \
  in_dir "$ROOT" env DATABASE_URL="$SEED_URL" DIRECT_URL="$SEED_URL" "$TSX" "$WORK/read-check.ts"

# Running the file a second time must be refused and change nothing (every column of every table, new ones included).
SNAP4_ALL_SQL="$WORK/snapshot4-all.sql"
build_snapshot_sql "$S" "$SNAP4_ALL_SQL"
expect_refused "$S" "second Phase 4 run refused (\"already applied\") and nothing changed" \
  "$PHASE4_SQL" "Phase 4 migration already applied" "$SNAP4_ALL_SQL"

info "after the Phase 4 SQL: KpiSuggestionRun rows: $(q "$S" 'SELECT count(*) FROM "KpiSuggestionRun"'), KpiSuggestion rows: $(q "$S" 'SELECT count(*) FROM "KpiSuggestion"')"

# --- 4. rollout order from today's shared schema ------------------------------------------------------------------

section "4. Rollout order from the schema shared databases had before Phase 0 ($PRE_PHASE0_REV): Phase 0, Phase 2, Phase 3, Phase 4 SQL"
create_db "$CHAIN_DB"
info "created $CHAIN_DB"
CHAIN="$WORK/chain"
mkdir -p "$CHAIN"
git -C "$ROOT" show "$PRE_PHASE0_REV:prisma/schema.prisma" >"$CHAIN/schema.prisma"
grep -q '^model WebhookToken' "$CHAIN/schema.prisma" && die "the schema at $PRE_PHASE0_REV already has WebhookToken (not the pre-Phase 0 schema)"
run_quiet "schema at $PRE_PHASE0_REV pushed (before Phase 0: no WebhookToken)" \
  in_dir "$CHAIN" env DATABASE_URL="$CHAIN_URL" DIRECT_URL="$CHAIN_URL" "$PRISMA" db push --schema schema.prisma --skip-generate
build_snapshot_sql "$CHAIN_URL" "$WORK/snapshot-chain.sql"
expect_refused "$CHAIN_URL" "Phase 3 SQL refused before the Phase 0 SQL (\"needs the Phase 0 SQL first\"), nothing changed" \
  "$PHASE3_SQL" "Phase 3 migration needs the Phase 0 SQL first" "$WORK/snapshot-chain.sql"
run_quiet "Phase 0 SQL applied" psql "$CHAIN_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE0_SQL"
run_quiet "Phase 2 SQL applied" psql "$CHAIN_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE2_SQL"
build_snapshot_sql "$CHAIN_URL" "$WORK/snapshot-chain2.sql"
expect_refused "$CHAIN_URL" "Phase 4 SQL refused after Phase 2 but before Phase 3 (\"needs the Phase 3 SQL first\"), nothing changed" \
  "$PHASE4_SQL" "Phase 4 migration needs the Phase 3 SQL first" "$WORK/snapshot-chain2.sql"
run_quiet "Phase 3 SQL applied" psql "$CHAIN_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE3_SQL"
expect_eq "$CHAIN_URL" "row level security enabled on WebhookToken, ResultNode, IndicatorLibraryEntry and AiCall" "4" \
  "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
     AND relname IN ('WebhookToken', 'ResultNode', 'IndicatorLibraryEntry', 'AiCall') AND relrowsecurity"
check_no_drift "$CHAIN_URL" "no drift between the database after Phase 0, Phase 2 and Phase 3 SQL and the Phase 3 schema ($PHASE3_REV)" "$PHASE3_SCHEMA"
run_quiet "Phase 4 SQL applied" psql "$CHAIN_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE4_SQL"
expect_eq "$CHAIN_URL" "row level security enabled on all six new tables (WebhookToken, ResultNode, IndicatorLibraryEntry, AiCall, KpiSuggestionRun, KpiSuggestion)" "6" \
  "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
     AND relname IN ('WebhookToken', 'ResultNode', 'IndicatorLibraryEntry', 'AiCall', 'KpiSuggestionRun', 'KpiSuggestion') AND relrowsecurity"
check_no_drift "$CHAIN_URL" "no drift between the database after Phase 0, Phase 2, Phase 3 and Phase 4 SQL and prisma/schema.prisma"

# --- 5. Supabase layout: pgvector in the extensions schema ----------------------------------------------------------

section "5. Supabase layout: pgvector in an \"extensions\" schema, rollout order from $PRE_PHASE0_REV (Phase 0, 2, 3, 4)"
create_db "$EXT_DB"
info "created $EXT_DB"
# As on Supabase: the extension lives in its own schema, and the roles' search_path ("$user", public, extensions)
# includes it, so psql and Prisma connections without ?schema= find the vector type.
run_quiet "pgvector created in schema extensions; database search_path \"\$user\", public, extensions" \
  psql "$EXT_URL" -X -q -v ON_ERROR_STOP=1 -c 'CREATE SCHEMA extensions' -c 'CREATE EXTENSION vector WITH SCHEMA extensions' \
    -c "ALTER DATABASE \"$EXT_DB\" SET search_path TO \"\$user\", public, extensions"
run_quiet "schema at $PRE_PHASE0_REV pushed (Prisma keeps the existing extension)" \
  in_dir "$CHAIN" env DATABASE_URL="$EXT_URL" DIRECT_URL="$EXT_URL" "$PRISMA" db push --schema schema.prisma --skip-generate
run_quiet "Phase 0 SQL applied" psql "$EXT_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE0_SQL"
run_quiet "Phase 2 SQL applied (vector(1024) resolved through the search_path)" psql "$EXT_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE2_SQL"
run_quiet "Phase 3 SQL applied" psql "$EXT_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE3_SQL"
run_quiet "Phase 4 SQL applied" psql "$EXT_URL" -X -q -v ON_ERROR_STOP=1 -f "$PHASE4_SQL"
expect_eq "$EXT_URL" "pgvector still lives only in the extensions schema (no vector type created in public)" "extensions|0" \
  "SELECT e.extnamespace::regnamespace::text || '|' || (SELECT count(*) FROM pg_type WHERE typname = 'vector' AND typnamespace = 'public'::regnamespace)
   FROM pg_extension e WHERE e.extname = 'vector'"
check_no_drift "$EXT_URL" "no drift between the database with pgvector in extensions and prisma/schema.prisma"
run_quiet "the app's Prisma client creates, reads and deletes AiCall rows (pgvector in extensions)" \
  in_dir "$ROOT" env DATABASE_URL="$EXT_URL" DIRECT_URL="$EXT_URL" "$TSX" "$WORK/aicall-check.ts"
run_quiet "the app's Prisma client writes, reads and deletes KPI runs and suggestions (pgvector in extensions)" \
  in_dir "$ROOT" env DATABASE_URL="$EXT_URL" DIRECT_URL="$EXT_URL" "$TSX" "$WORK/kpi-check.ts"

# What the app must cope with: a Prisma URL with ?schema=public sets search_path to public only. Then a bare ::vector
# cast (and the bare <=> operator) cannot be found, while the column's own type, read from the catalogue
# schema-qualified (as the embedding code resolves it at runtime), works for writing and comparing vectors.
EXT_PUBLIC_ONLY=(env PGOPTIONS="-c search_path=public" psql "$EXT_URL" -X -At -q -v ON_ERROR_STOP=1)
if "${EXT_PUBLIC_ONLY[@]}" -c "SELECT '[1,0,0]'::vector" >"$WORK/ext-bare.log" 2>&1; then
  fail "with search_path = public a bare ::vector cast worked (expected type \"vector\" does not exist)"
elif grep -qF 'type "vector" does not exist' "$WORK/ext-bare.log"; then
  pass "with search_path = public (Prisma's ?schema=public) a bare ::vector cast fails: type \"vector\" does not exist"
else
  fail "bare ::vector cast with search_path = public failed for an unexpected reason:"
  sed 's/^/        /' "$WORK/ext-bare.log" | tail -n 10
fi
cat >"$WORK/ext-vector.sql" <<'SQL'
BEGIN;
SELECT format_type(atttypid, NULL) AS t FROM pg_attribute
WHERE attrelid = '"IndicatorLibraryEntry"'::regclass AND attname = 'embedding' \gset vector_
SELECT 'type:' || :'vector_t';
INSERT INTO "IndicatorLibraryEntry" (id, sector, tags, level, name, "nameAr", definition, unit, direction, disaggregation,
                                     methods, frequency, "meansOfVerification", "isStandard", version, "updatedAt")
VALUES ('p3v-lib', (enum_range(NULL::"Sector"))[1], '{}', 'outcome', 'Fixture entry', 'مؤشر تجريبي', 'Fixture.', 'number',
        'increase', '{}', '{}', (enum_range(NULL::"Frequency"))[1], 'Fixture.', false, 'verify', now());
UPDATE "IndicatorLibraryEntry"
SET embedding = CAST('[' || array_to_string(array_fill(0.5::float4, ARRAY[1024]), ',') || ']' AS :vector_t),
    "embeddingModel" = 'verify-model'
WHERE id = 'p3v-lib';
SELECT 'stored:' || extensions.vector_dims(embedding) || ':' || "embeddingModel" || ':' || (embedding OPERATOR(extensions.<=>) embedding)
FROM "IndicatorLibraryEntry" WHERE id = 'p3v-lib';
-- Phase 4 retrieval (dbLibrarySource) reads the vectors as text and compares them in code: no type or operator name.
SELECT 'as text:' || left("embedding"::text, 12) || ':' || (length("embedding"::text) - length(replace("embedding"::text, ',', '')) + 1)
FROM "IndicatorLibraryEntry" WHERE id = 'p3v-lib' AND "embeddingModel" = 'verify-model';
ROLLBACK;
SQL
EXT_OUT="$("${EXT_PUBLIC_ONLY[@]}" -f "$WORK/ext-vector.sql" 2>&1 | tr '\n' ';')" || true
if [[ "$EXT_OUT" == "type:extensions.vector;stored:1024:verify-model:0;as text:[0.5,0.5,0.5:1024;" ]]; then
  pass "with search_path = public the column's own type (extensions.vector) stores a 1024-dimension vector, OPERATOR(extensions.<=>) compares it and \"embedding\"::text reads all 1024 values back (rolled back)"
else
  fail "schema-qualified vector write with search_path = public (got '$EXT_OUT')"
fi
if "${EXT_PUBLIC_ONLY[@]}" -c "SELECT '[1,0]'::extensions.vector <=> '[0,1]'::extensions.vector" >"$WORK/ext-op.log" 2>&1; then
  fail "with search_path = public the bare <=> operator worked (expected operator does not exist)"
elif grep -qF 'operator does not exist' "$WORK/ext-op.log"; then
  pass "with search_path = public the bare <=> operator is not found either (vector search must not hide the extensions schema)"
else
  fail "bare <=> with search_path = public failed for an unexpected reason:"
  sed 's/^/        /' "$WORK/ext-op.log" | tail -n 10
fi
expect_zero "$EXT_URL" "the rolled-back vector write left no library row behind" \
  "SELECT count(*) FROM \"IndicatorLibraryEntry\""

# --- summary -----------------------------------------------------------------------------------------------------

section "Summary"
if [[ $FAILURES -eq 0 ]]; then
  printf 'PASS  %d checks passed, 0 failed\n' "$PASSES"
else
  printf 'FAIL  %d checks passed, %d failed\n' "$PASSES" "$FAILURES"
  exit 1
fi
