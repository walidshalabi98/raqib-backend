/**
 * KPI suggestion runs: the status row the UI polls, the in-process executor with its heartbeat and deadline, conflict
 * checks under a per-project advisory lock, and the DTOs (knowledge/kpi-assistant-spec.md §A6; design sections 4.5
 * and 7.4, D3).
 *
 * Step 0 stub (Phase 4 contracts): constants, types and signatures are final; E5 implements the bodies.
 */
import type { KpiSuggestion, KpiSuggestionRun, Prisma, PrismaClient } from '@prisma/client';
import type { KpiErrorCode, KpiPipelineDeps, KpiRunDto, KpiScope, KpiSuggestionDto } from './types';

export const KPI_SYNC_WAIT_MS = 20_000;
/** Timer: touches updatedAt while executeKpiRun runs in this process. */
export const KPI_HEARTBEAT_MS = 30_000;
/** No heartbeat for 15 min (30 missed beats) → reported failed/interrupted. */
export const KPI_RUN_STALE_MS = 15 * 60_000;

export interface KpiRunDeps { db: PrismaClient; pipeline: () => KpiPipelineDeps; now: () => Date }

/**
 * Takes pg_advisory_xact_lock(hashtext('kpi-run:' || projectId)) in a transaction, re-checks findConflictingRun (409
 * run_in_progress) and creates the row; then starts executeKpiRun (never rejects `done`).
 */
export async function startKpiRun(_input: { projectId: string; organizationId: string; frameworkId: string; scope: KpiScope; requestedBy: string },
  _deps?: Partial<KpiRunDeps>): Promise<{ run: KpiSuggestionRun; done: Promise<void> }> {
  throw new Error('Phase 4: not implemented (E5)');
}

/** context → pipeline → one persisting transaction; every write conditional on status 'running' (design 4.5). */
export async function executeKpiRun(_runId: string, _deps: KpiRunDeps): Promise<void> {
  throw new Error('Phase 4: not implemented (E5)');
}

/** Run ids executing in this process (heartbeat owners); the SIGTERM handler in src/index.ts marks them failed/interrupted. */
export function activeRunIds(): string[] {
  throw new Error('Phase 4: not implemented (E5)');
}

export async function markRunsInterrupted(_db: PrismaClient, _runIds: readonly string[]): Promise<number> {
  throw new Error('Phase 4: not implemented (E5)');
}

/** The failure to report for a run (stored, or interrupted when running without a heartbeat for KPI_RUN_STALE_MS); null otherwise. */
export function runFailure(_run: Pick<KpiSuggestionRun, 'status' | 'updatedAt' | 'errorCode' | 'error'>, _now: Date): { errorCode: KpiErrorCode; message: string } | null {
  throw new Error('Phase 4: not implemented (E5)');
}

/**
 * Safe messages only: AiRefusalError → ai_refused; AiRequestError 401/403 → ai_not_configured; other AiRequestError →
 * ai_unavailable; AiOutputTruncatedError / AiInvalidOutputError → ai_invalid_output; KpiPipelineError → its code;
 * KpiContextError stale → stale; anything else → internal.
 */
export function errorCodeFor(_err: unknown): { errorCode: KpiErrorCode; message: string } {
  throw new Error('Phase 4: not implemented (E5)');
}

/** True when `done` settled within `ms`. */
export async function waitForRun(_done: Promise<void>, _ms: number): Promise<boolean> {
  throw new Error('Phase 4: not implemented (E5)');
}

/**
 * Conflicts (section 7.2 step 8): a running framework run blocks every new run of the project's framework; a running
 * result or alternatives run blocks a framework run and another run for the same result. Stale runs are ignored.
 */
export async function findConflictingRun(_db: Prisma.TransactionClient | PrismaClient,
  _where: { projectId: string; frameworkId: string; scope: KpiScope; resultId: string | null }, _now: Date): Promise<KpiSuggestionRun | null> {
  throw new Error('Phase 4: not implemented (E5)');
}

/** Stores failed/interrupted on the project's running runs without a heartbeat for KPI_RUN_STALE_MS; returns the count. */
export async function markStaleRuns(_db: Prisma.TransactionClient | PrismaClient, _projectId: string, _now: Date): Promise<number> {
  throw new Error('Phase 4: not implemented (E5)');
}

export function toRunDto(_run: KpiSuggestionRun, _now: Date): KpiRunDto {
  throw new Error('Phase 4: not implemented (E5)');
}

export function toSuggestionDto(_row: KpiSuggestion): KpiSuggestionDto {
  throw new Error('Phase 4: not implemented (E5)');
}
