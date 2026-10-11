import { UserRole } from '@prisma/client';
import type { WebhookContext } from '../middleware/webhookAuth';

export interface AuthUser {
  id: string;
  email: string;
  organizationId: string;
  role: UserRole;
  fullName: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      rawBody?: Buffer;
      webhook?: WebhookContext;
    }
  }
}
