import { Request, Response, NextFunction, RequestHandler } from 'express';

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

  // Prisma known errors
  if (err.constructor?.name === 'PrismaClientKnownRequestError') {
    const prismaErr = err as any;
    if (prismaErr.code === 'P2002') {
      res.status(409).json({ message: 'A record with that value already exists' });
      return;
    }
    if (prismaErr.code === 'P2025') {
      res.status(404).json({ message: 'Record not found' });
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
