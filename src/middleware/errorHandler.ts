import { Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
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

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error('Error:', err.message);
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ message: err.message });
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
