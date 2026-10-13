import { Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';

/**
 * An error the API answers with on purpose: `statusCode`, a safe English `message`, and optionally a machine-readable
 * `code` (e.g. the KPI Assistant's KpiRequestErrorCode: 'run_in_progress', 'budget_reached'; design section 7) and
 * `details` (ids and counts only, e.g. `{ runId }`). The JSON body is `{ message, code?, details? }`; existing callers
 * that pass only the status and message are unchanged.
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** The JSON body of an AppError: `{ message, code?, details? }` (code and details only when set). */
export function appErrorBody(err: AppError): { message: string; code?: string; details?: Record<string, unknown> } {
  return {
    message: err.message,
    ...(err.code !== undefined && { code: err.code }),
    ...(err.details !== undefined && { details: err.details }),
  };
}

/**
 * Wraps an async route handler to catch rejected promises
 * and forward them to Express error handling middleware.
 * Without this, unhandled rejections crash the Node.js process.
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * What the error handler logs. AppError messages are written by the API and safe to log. Any other
 * error is logged by class name and code only, and outside production with its stack frames: the
 * message is left out because database and library errors quote the values they were given (a
 * Prisma validation error prints the whole record, names and notes included; CLAUDE.md rules 3 and 5).
 */
export function errorLogLines(err: Error, production = process.env.NODE_ENV === 'production'): string[] {
  if (err instanceof AppError) return [`Error: ${err.message}`];
  const code = (err as { code?: unknown }).code;
  const lines = [`Error: ${err.name || 'Error'}${typeof code === 'string' ? ` (${code})` : ''}`];
  if (!production && err.stack) {
    const frames = err.stack.split('\n').filter(line => /^\s+at /.test(line));
    if (frames.length > 0) lines.push(frames.join('\n'));
  }
  return lines;
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  for (const line of errorLogLines(err)) console.error(line);

  if (err instanceof AppError) {
    res.status(err.statusCode).json(appErrorBody(err));
    return;
  }

  if (err instanceof multer.MulterError) {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      message: tooLarge ? 'The file is too large. The maximum size is 25 MB.' : 'The upload could not be processed.',
    });
    return;
  }

  // Invalid or expired refresh / reset tokens
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    res.status(401).json({ message: 'Invalid or expired token' });
    return;
  }

  // Malformed JSON body
  if ((err as any).type === 'entity.parse.failed') {
    res.status(400).json({ message: 'The request body is not valid JSON.' });
    return;
  }

  // Prisma known errors
  if (err.constructor?.name === 'PrismaClientKnownRequestError') {
    const prismaErr = err as any;
    if (prismaErr.code === 'P2002') {
      // ResultNode @@unique([frameworkId, code]): a duplicate that got past the API's check (e.g. two requests at once).
      const target: unknown = prismaErr.meta?.target;
      const resultCode = prismaErr.meta?.modelName === 'ResultNode' && Array.isArray(target) && target.includes('code');
      res.status(409).json({ message: resultCode ? 'A result with that code already exists in this framework' : 'A record with that value already exists' });
      return;
    }
    if (prismaErr.code === 'P2025') {
      res.status(404).json({ message: 'Record not found' });
      return;
    }
    // Foreign key violation: the request refers to a record that does not exist (often deleted meanwhile).
    if (prismaErr.code === 'P2003') {
      res.status(400).json({ message: 'A related record does not exist (it may have been deleted).' });
      return;
    }
  }

  // Prisma validation errors (bad enum values, etc.)
  if (err.constructor?.name === 'PrismaClientValidationError') {
    res.status(400).json({ message: 'Invalid data provided. Check field values.' });
    return;
  }

  res.status(500).json({ message: 'Internal server error' });
}
