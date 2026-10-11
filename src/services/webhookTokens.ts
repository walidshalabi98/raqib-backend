import crypto from 'crypto';
import { prisma } from '../config/prisma';

const TOKEN_PREFIX = 'rqb_wh_';

export function hashWebhookToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Creates a new webhook token for an organisation. The plain token is returned once and never stored. */
export async function createWebhookToken(organizationId: string, createdById: string) {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const record = await prisma.webhookToken.create({
    data: {
      organizationId,
      createdById,
      tokenHash: hashWebhookToken(token),
      tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 6),
    },
  });
  return { token, record };
}

/** Returns the active token record for a presented token, or null. */
export async function findActiveWebhookToken(token: string) {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  return prisma.webhookToken.findFirst({
    where: { tokenHash: hashWebhookToken(token), revokedAt: null },
  });
}

/** Verifies an X-Raqib-Signature header ("sha256=<hex>") against the raw request body. */
export function verifyWebhookSignature(rawBody: Buffer, header: string, secret: string): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(match[1], 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
