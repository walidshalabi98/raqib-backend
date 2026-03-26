import { UserRole } from '@prisma/client';

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
    }
  }
}
