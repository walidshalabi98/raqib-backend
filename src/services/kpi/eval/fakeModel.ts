/**
 * A deterministic fake ModelCaller for `npm run eval:kpi -- --fake` and the tests (design section 10.2): per result the
 * top min(allowance.max, 3) candidates → rawSuggestionFromLibrary; outputTokens = ceil(answer JSON length / 4) as a
 * latency proxy, other tokens 0; cost 0. No key, no network.
 *
 * Step 0 stub (Phase 4 contracts): the signature is final; E6 implements the body.
 */
import type { ModelCaller } from '../types';

/** Faults the fake can inject to prove the validator and the metrics catch them. */
export type FakeModelInjection = 'targetInName' | 'unknownLibraryId' | 'hallucinatedTarget' | 'baselineFromTarget' | 'invalid' | 'refuse';

export function fakeKpiModelCaller(_opts?: { inject?: Partial<Record<FakeModelInjection, boolean>> }): ModelCaller {
  throw new Error('Phase 4: not implemented (E6)');
}
