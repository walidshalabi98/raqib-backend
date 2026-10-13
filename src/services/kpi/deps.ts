/**
 * Production dependencies of the KPI pipeline (design sections 2 and 4.4): the database library source, the
 * query-time embedding provider (Voyage with an 8 s timeout and at most 1 retry, else no-op) and the real model
 * caller. Never imported by the eval (it must not touch a database).
 *
 * Step 0 stub (Phase 4 contracts): signatures are final; E4 implements the bodies.
 */
import type { EmbeddingProvider } from '../ai/embeddingProviders';
import type { KpiPipelineDeps } from './types';

/** env.voyageApiKey ? Voyage (timeoutMs 8_000, maxRetries 1) : NoopEmbeddingProvider. */
export function queryEmbeddingProvider(): EmbeddingProvider {
  throw new Error('Phase 4: not implemented (E4)');
}

/** { library: dbLibrarySource(prisma), embeddings: queryEmbeddingProvider(), callModel: defaultModelCaller, now: () => new Date() }. */
export function productionPipelineDeps(): KpiPipelineDeps {
  throw new Error('Phase 4: not implemented (E4)');
}
