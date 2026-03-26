import express from 'express';
import cors from 'cors';
import path from 'path';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { authenticate } from './middleware/auth';
import { auditMiddleware } from './middleware/audit';
import { errorHandler } from './middleware/errorHandler';
import './types/express';

// Route imports
import authRoutes from './routes/auth';
import organizationRoutes from './routes/organizations';
import userRoutes from './routes/users';
import projectRoutes from './routes/projects';
import documentRoutes from './routes/documents';
import frameworkRoutes from './routes/frameworks';
import indicatorRoutes from './routes/indicators';
import assessmentRoutes from './routes/assessments';
import dataPointRoutes from './routes/dataPoints';
import qualitativeRoutes from './routes/qualitative';
import reportRoutes from './routes/reports';
import dashboardRoutes from './routes/dashboard';
import notificationRoutes from './routes/notifications';
import templateRoutes from './routes/templates';
import webhookRoutes from './routes/webhooks';

const app = express();

// Global middleware
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:8080',
    'http://localhost:3000',
    'http://[::1]:8080',
    env.appUrl,
    ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : []),
  ].filter(Boolean),
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Audit middleware for write operations
app.use('/api', auditMiddleware);

// Public routes
app.use('/api/auth', authRoutes);
app.use('/api/webhooks', webhookRoutes);

// Protected routes
app.use('/api/organizations', organizationRoutes);
app.use('/api/users', userRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api', documentRoutes);      // /api/projects/:id/documents & /api/documents/:id
app.use('/api', frameworkRoutes);      // /api/projects/:id/framework & /api/frameworks/:id
app.use('/api/indicators', indicatorRoutes);
app.use('/api', assessmentRoutes);     // /api/projects/:id/assessments & /api/assessments/:id
app.use('/api', dataPointRoutes);      // /api/indicators/:id/data & /api/projects/:id/data/bulk
app.use('/api', qualitativeRoutes);    // /api/projects/:id/qualitative & /api/qualitative/:id
app.use('/api', reportRoutes);         // /api/projects/:id/reports & /api/reports/:id
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/templates', templateRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use(errorHandler);

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
