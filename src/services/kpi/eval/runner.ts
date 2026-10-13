/**
 * Runs the KPI evaluation cases through the same runKpiPipeline as production (design section 10.2): framework scope
 * per case (assertions) plus one result-scope run for the first outcome (latency), each case in its own try/catch, and
 * no new case once the spend reaches maxUsd. Never touches a database.
 *
 * Step 0 stub (Phase 4 contracts): the signature is final; E6 implements the body.
 */
import type { KpiPipelineDeps } from '../types';
import type { EvalCase } from './cases';
import type { EvalReport } from './report';

export async function runEval(_input: { cases: EvalCase[]; deps: KpiPipelineDeps; maxUsd: number; resultCheck: boolean; now: () => Date;
  log: (line: string) => void }): Promise<EvalReport> {
  throw new Error('Phase 4: not implemented (E6)');
}
