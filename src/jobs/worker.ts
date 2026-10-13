import { Worker, Job } from 'bullmq';
import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { redis } from '../config/redis';
import { parseDocument } from '../services/ai/documentParser';
import { generateFramework } from '../services/ai/frameworkGenerator';
import { generateReportNarrative } from '../services/ai/reportNarrative';
import { codeQualitativeEntry } from '../services/ai/qualitativeCoder';
import { loadSharedSystemPrompt } from '../services/ai/prompts/system';
import { safeErrorSummary } from '../services/ai/errors';
import { MAINTENANCE_QUEUE, PRUNE_AI_CALLS_SCHEDULE, runMaintenanceJob, scheduleAiCallPruning } from '../services/maintenance/aiCallRetention';
import { getMaintenanceQueue } from './queues';

console.log('[Worker] Starting RAQIB job workers...');

// Fail fast when the AI system prompt (knowledge/me-foundations.md §1–12) cannot be built.
try {
  console.log(`[Worker] AI system prompt: ${loadSharedSystemPrompt().version}`);
} catch (err) {
  console.error(`[Worker] ${(err as Error).message}`);
  process.exit(1);
}

// Document Parsing Worker
const documentWorker = new Worker('document-parsing', async (job: Job) => {
  console.log(`[Worker] Parsing document ${job.data.documentId}`);
  await parseDocument(job.data.documentId);
}, { connection: redis, concurrency: 2 });

documentWorker.on('completed', (job) => {
  console.log(`[Worker] Document parsing completed: ${job.id}`);
});
documentWorker.on('failed', (job, err) => {
  console.error(`[Worker] Document parsing failed: ${job?.id}: ${safeErrorSummary(err)}`);
});

// Framework Generation Worker
const frameworkWorker = new Worker('framework-generation', async (job: Job) => {
  console.log(`[Worker] Generating framework ${job.data.frameworkId}`);
  await generateFramework(job.data.frameworkId, job.data.projectId);
}, { connection: redis, concurrency: 1 });

frameworkWorker.on('completed', (job) => {
  console.log(`[Worker] Framework generation completed: ${job.id}`);
});
frameworkWorker.on('failed', (job, err) => {
  console.error(`[Worker] Framework generation failed: ${job?.id}: ${safeErrorSummary(err)}`);
});

// Indicator alternatives: the Phase 3 'indicator-alternatives' worker was removed in Phase 4 (nothing enqueued to it);
// alternatives now come from the KPI Assistant (src/services/kpi/, POST /api/indicators/:id/alternative).

// Report Generation Worker
const reportWorker = new Worker('report-generation', async (job: Job) => {
  console.log(`[Worker] Generating report ${job.data.reportId}`);
  await generateReportNarrative(job.data.reportId, job.data.projectId);
}, { connection: redis, concurrency: 1 });

reportWorker.on('completed', (job) => {
  console.log(`[Worker] Report generation completed: ${job.id}`);
});
reportWorker.on('failed', (job, err) => {
  console.error(`[Worker] Report generation failed: ${job?.id}: ${safeErrorSummary(err)}`);
});

// Qualitative Coding Worker
const qualitativeWorker = new Worker('qualitative-coding', async (job: Job) => {
  console.log(`[Worker] Coding qualitative entry ${job.data.entryId}`);
  await codeQualitativeEntry(job.data.entryId, job.data.projectId);
}, { connection: redis, concurrency: 2 });

qualitativeWorker.on('completed', (job) => {
  console.log(`[Worker] Qualitative coding completed: ${job.id}`);
});
qualitativeWorker.on('failed', (job, err) => {
  console.error(`[Worker] Qualitative coding failed: ${job?.id}: ${safeErrorSummary(err)}`);
});

// Maintenance Worker: the nightly AiCall retention job (AI_CALL_RETENTION_MONTHS, default 24)
const maintenanceWorker = new Worker(MAINTENANCE_QUEUE, async (job: Job) => {
  return runMaintenanceJob(job, { prisma, months: env.aiCallRetentionMonths });
}, { connection: redis, concurrency: 1 });

maintenanceWorker.on('failed', (job, err) => {
  console.error(`[Worker] Maintenance job ${job?.name} failed: ${job?.id}: ${safeErrorSummary(err)}`);
});

// Registered at every start; the fixed scheduler id keeps it to one schedule.
scheduleAiCallPruning(getMaintenanceQueue())
  .then(() => console.log(`[Worker] AiCall retention: ${env.aiCallRetentionMonths} months, pruned on "${PRUNE_AI_CALLS_SCHEDULE.pattern}" (${PRUNE_AI_CALLS_SCHEDULE.tz})`))
  .catch(err => console.error(`[Worker] Scheduling the AiCall retention job failed: ${safeErrorSummary(err)}`));

// Graceful shutdown
async function shutdown() {
  console.log('[Worker] Shutting down workers...');
  await Promise.all([
    documentWorker.close(),
    frameworkWorker.close(),
    reportWorker.close(),
    qualitativeWorker.close(),
    maintenanceWorker.close(),
    getMaintenanceQueue().close(), // the shared Redis connection stays open
  ]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('[Worker] All workers started successfully');
