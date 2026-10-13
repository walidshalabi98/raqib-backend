/**
 * runKpiPipeline: retrieveCandidates → callModelForResults → validateAndScore (knowledge/kpi-assistant-spec.md §A4;
 * design sections 2 and 4.4). Never imports prisma: the run executor, framework generation and the eval inject
 * KpiPipelineDeps.
 *
 * Step 0 stub (Phase 4 contracts): KpiPipelineError and the signature are final; E4 implements runKpiPipeline.
 */
import { AiError } from '../ai/errors';
import type { KpiErrorCode, KpiPipelineDeps, KpiPipelineOptions, KpiPipelineResult, ProjectContext } from './types';

/**
 * Pipeline failures that are not an AiError of the client. Extends AiError, so generationFailureMessage and
 * safeErrorSummary keep its (safe) message.
 */
export class KpiPipelineError extends AiError {
  constructor(readonly code: KpiErrorCode, feature: string, message: string) {
    super(message, feature);
    this.name = 'KpiPipelineError';
  }
}

export async function runKpiPipeline(_ctx: ProjectContext, _deps: KpiPipelineDeps, _opts?: KpiPipelineOptions): Promise<KpiPipelineResult> {
  throw new Error('Phase 4: not implemented (E4)');
}
