import { env } from './config/env';
import { prisma } from './config/prisma';
import app from './app';

// Start server
const server = app.listen(env.port, () => {
  console.log(`🚀 RAQIB Backend running on port ${env.port}`);
  console.log(`   Environment: ${env.nodeEnv}`);
  console.log(`   Health check: http://localhost:${env.port}/api/health`);
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
