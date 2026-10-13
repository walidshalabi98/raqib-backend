/**
 * Production dependencies of the KPI pipeline (design sections 2 and 4.4; SDA-17): the database library source, the
 * query-time embedding provider (Voyage with an 8 s timeout and at most 1 retry, else no-op) and the real model caller.
 * Never imported by the eval (it must not touch a database, design 10.1).
 */
import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { NoopEmbeddingProvider, VoyageEmbeddingProvider, type EmbeddingProvider } from '../ai/embeddingProviders';
import { defaultModelCaller } from './callModel';
import { dbLibrarySource } from './librarySource';
import type { KpiPipelineDeps } from './types';

/** Timeout of one Voyage request at query time (a slow Voyage costs at most about 20 s before the keyword fallback). */
export const QUERY_EMBEDDING_TIMEOUT_MS = 8_000;
/** Retries of a Voyage request at query time. */
export const QUERY_EMBEDDING_MAX_RETRIES = 1;

/**
 * The embedding provider for result statements and indicator names at query time (spec §A4 step 1 "embed result
 * statements at query time (input_type: query)"; design 4.3, SDA-17): env.voyageApiKey ? Voyage (model VOYAGE_MODEL,
 * timeout 8 s, 1 retry) : NoopEmbeddingProvider (keyword retrieval, text-only near-duplicates).
 */
export function queryEmbeddingProvider(): EmbeddingProvider {
  const apiKey = env.voyageApiKey?.trim();
  if (!apiKey) return new NoopEmbeddingProvider();
  return new VoyageEmbeddingProvider({
    apiKey, model: env.voyageModel, timeoutMs: QUERY_EMBEDDING_TIMEOUT_MS, maxRetries: QUERY_EMBEDDING_MAX_RETRIES,
  });
}

/**
 * KpiPipelineDeps for the API (run executor) and framework generation (design 2): { library: dbLibrarySource(prisma),
 * embeddings: queryEmbeddingProvider(), callModel: defaultModelCaller, now: () => new Date() }.
 */
export function productionPipelineDeps(): KpiPipelineDeps {
  return {
    library: dbLibrarySource(prisma),
    embeddings: queryEmbeddingProvider(),
    callModel: defaultModelCaller,
    now: () => new Date(),
  };
}
