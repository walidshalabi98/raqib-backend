import { env } from './config/env';
import { prisma } from './config/prisma';
import { loadSharedSystemPrompt } from './services/ai/prompts/system';
import { safeErrorSummary } from './services/ai/errors';
import { resolveModel } from './services/ai/client';
import { budgetPricingWarning } from './services/kpi/availability';
import { interruptActiveRuns } from './services/kpi/runs';
import app from './app';

// Fail fast when the AI system prompt (knowledge/me-foundations.md §1–12) cannot be built.
function loadSystemPromptVersion(): string {
  try {
    return loadSharedSystemPrompt().version;
  } catch (err) {
    console.error(`\n${(err as Error).message}\n`);
    process.exit(1);
  }
}
const systemPromptVersion = loadSystemPromptVersion();

// CC-07: a model without a price makes the organisation's daily AI budget count 0 for its calls; say so loudly.
const budgetWarning = budgetPricingWarning(env.aiOrgDailyBudgetUsd, [resolveModel('main'), resolveModel('fast')]);
if (budgetWarning) console.warn(budgetWarning);

// Start server
const server = app.listen(env.port, () => {
  console.log(`🚀 RAQIB Backend running on port ${env.port}`);
  console.log(`   Environment: ${env.nodeEnv}`);
  console.log(`   Health check: http://localhost:${env.port}/api/health`);
  console.log(`   AI system prompt: ${systemPromptVersion}`);
});

// Catch unhandled rejections and uncaught exceptions — prevent crashes
// Class names only: error messages can quote stored values (CLAUDE.md rules 3 and 5).
process.on('unhandledRejection', (reason: unknown) => {
  console.error('Unhandled Rejection:', safeErrorSummary(reason));
});

process.on('uncaughtException', (err: Error) => {
  console.error('Uncaught Exception:', safeErrorSummary(err));
  // Don't exit — let the server keep running
});

// Graceful shutdown. KPI suggestion runs executing in this process are marked interrupted at once, so the UI offers
// "try again" instead of waiting 15 minutes for the missing heartbeat (design section 7.4).
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down...');
  server.close();
  try {
    const interrupted = await interruptActiveRuns(prisma);
    if (interrupted > 0) console.log(`[KpiRun] marked ${interrupted} running run(s) interrupted`);
  } catch (err) {
    console.error(`[KpiRun] could not mark running runs interrupted: ${safeErrorSummary(err)}`);
  }
  await prisma.$disconnect();
  process.exit(0);
});

export default app;
