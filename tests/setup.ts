import os from 'os';
import path from 'path';
import { vi } from 'vitest';

// Test configuration. Integration tests use TEST_DATABASE_URL (a disposable
// database whose name contains "test"); they are skipped when it is not set.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://unused:unused@localhost:5432/unused_test';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef01234567';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
process.env.WEBHOOK_SECRET = 'test-webhook-secret';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_KEY = '';
process.env.LOCAL_STORAGE_DIR = path.join(os.tmpdir(), `raqib-test-storage-${process.pid}`);
process.env.API_URL = 'http://127.0.0.1';
// An accidental real SDK call fails at once (nothing listens on port 9), without network.
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
process.env.VOYAGE_API_KEY = '';

// Never call a real AI model from tests.
vi.mock('../src/services/ai/documentParser', () => ({ parseDocument: vi.fn().mockResolvedValue(undefined), chunkText: vi.fn() }));
vi.mock('../src/services/ai/frameworkGenerator', () => ({ generateFramework: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/services/ai/qualitativeCoder', () => ({ codeQualitativeEntry: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/services/ai/reportNarrative', () => ({ generateReportNarrative: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/services/ai/assessmentGenerator', () => ({ generateAutoAssessment: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/services/ai/riskAnalyzer', () => ({ analyzeProjectRisks: vi.fn().mockResolvedValue([]) }));
