import { env } from './config/env';
import { prisma } from './config/prisma';
import { loadSharedSystemPrompt } from './services/ai/prompts/system';
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

// Start server
const server = app.listen(env.port, () => {
  console.log(`🚀 RAQIB Backend running on port ${env.port}`);
  console.log(`   Environment: ${env.nodeEnv}`);
  console.log(`   Health check: http://localhost:${env.port}/api/health`);
  console.log(`   AI system prompt: ${systemPromptVersion}`);
});

// Catch unhandled rejections and uncaught exceptions — prevent crashes
process.on('unhandledRejection', (reason: any) => {
  console.error('Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err: Error) => {
  console.error('Uncaught Exception:', err.message);
  // Don't exit — let the server keep running
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down...');
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

export default app;
