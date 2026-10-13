import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { auditMiddleware } from './middleware/audit';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter, webhookLimiter } from './middleware/rateLimit';
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
import beneficiaryRoutes from './routes/beneficiaries';
import exportRoutes from './routes/exports';
import fileRoutes from './routes/files';
import resultRoutes from './routes/results';
import libraryRoutes from './routes/library';

const app = express();

// Behind one reverse proxy (Render, Railway, Fly) in production, so rate limits see the client IP.
app.set('trust proxy', env.isProduction ? 1 : false);

// Prisma returns BigInt for BIGINT columns (e.g. Document.fileSizeBytes), which JSON cannot encode.
app.set('json replacer', (_key: string, value: unknown) => (typeof value === 'bigint' ? Number(value) : value));

// Global middleware
app.use(helmet());
app.use(cors({
  origin: env.corsOrigins,
  credentials: true,
}));
app.use(express.json({
  limit: '10mb',
  // Keep the raw body for webhook signature verification.
  verify: (req, _res, buf) => {
    if (req.url?.startsWith('/api/webhooks')) (req as express.Request).rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use('/api', apiLimiter);

// Audit middleware for write operations
app.use('/api', auditMiddleware);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Public routes
app.use('/api/auth', authRoutes);            // each route has its own limit (authLimiters, src/routes/auth.ts)
app.use('/api/webhooks', webhookLimiter, webhookRoutes);   // authenticated by organisation webhook token
app.use('/api/files', fileRoutes);                         // authenticated by short-lived signed URL

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
app.use('/api', beneficiaryRoutes);       // /api/projects/:id/beneficiaries & /api/beneficiaries/:id
app.use('/api', exportRoutes);            // /api/projects/:id/export/*
app.use('/api', resultRoutes);            // /api/frameworks/:id/results & /api/results/:id
app.use('/api/indicator-library', libraryRoutes);

// Error handler
app.use(errorHandler);

export default app;
