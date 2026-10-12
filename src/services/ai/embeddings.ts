/**
 * Text embeddings for semantic search over the indicator library (BUILD_GUIDE Phase 3 task 6,
 * kpi-assistant-spec §A4 "Embeddings").
 *
 * The providers (Voyage, or none) live in embeddingProviders.ts, which never loads the API
 * configuration, so `npm run seed:library` needs only DATABASE_URL (and optionally the Voyage
 * settings). This module re-exports them and adds getEmbeddingProvider(), which reads the
 * validated app env (VOYAGE_API_KEY, VOYAGE_MODEL).
 */
import { env } from '../../config/env';
import { createEmbeddingProvider, type EmbeddingProvider, type EmbeddingSettings } from './embeddingProviders';

export * from './embeddingProviders';

/** Voyage when VOYAGE_API_KEY is set (model VOYAGE_MODEL, default voyage-4), otherwise the no-op provider. */
export function getEmbeddingProvider(settings: EmbeddingSettings = env): EmbeddingProvider {
  return createEmbeddingProvider(settings);
}
