import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';

export async function auditLog(
  userId: string,
  action: string,
  entity: string,
  entityId: string,
  previousValue?: unknown,
  newValue?: unknown,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId,
      action,
      entity,
      entityId,
      previousValue: previousValue ? JSON.parse(JSON.stringify(previousValue)) : undefined,
      newValue: newValue ? JSON.parse(JSON.stringify(newValue)) : undefined,
    },
  });
}

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && req.user) {
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      auditLog(
        req.user!.id,
        `${req.method} ${req.path}`,
        req.path.split('/')[2] || 'unknown',
        req.params.id || 'N/A',
        undefined,
        body,
      ).catch(console.error);
      return originalJson(body);
    };
  }
  next();
}
