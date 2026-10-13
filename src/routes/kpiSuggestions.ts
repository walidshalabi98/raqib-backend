import { Router } from 'express';

/**
 * KPI Assistant routes (knowledge/kpi-assistant-spec.md §A6; design section 7.1): POST/GET
 * /api/projects/:id/kpi-suggestions, GET /api/kpi-suggestion-runs/:id, POST /api/kpi-suggestions/:id/accept|reject,
 * GET /api/frameworks/:id/indicator-quality, GET /api/kpi-assistant/status.
 *
 * Step 0 (Phase 4 contracts): an empty router, not mounted yet. E5 adds the routes and mounts it in src/app.ts
 * (`app.use('/api', kpiSuggestionRoutes)`) together with tests/isolation.test.ts entries.
 */
const router = Router();

export default router;
