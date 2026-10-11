import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { findActiveWebhookToken, verifyWebhookSignature } from '../services/webhookTokens';

export const WEBHOOK_TOKEN_HEADER = 'x-raqib-webhook-token';
export const WEBHOOK_SIGNATURE_HEADER = 'x-raqib-signature';

export interface WebhookContext {
  organizationId: string;
  tokenId: string;
  /** User that imported records are attributed to (the token's creator). */
  userId: string;
}

/** Logs a rejected webhook call without the token or body. */
export function logWebhookRejection(req: Request, reason: string, extra: Record<string, unknown> = {}): void {
  console.warn('[Webhook] Rejected', JSON.stringify({
    path: req.originalUrl,
    ip: req.ip,
    reason,
    ...extra,
    at: new Date().toISOString(),
  }));
}

/**
 * Authenticates inbound webhooks with an organisation webhook token
 * (X-Raqib-Webhook-Token). When the sender also signs the body
 * (X-Raqib-Signature: sha256=<hex HMAC>), the signature must verify against WEBHOOK_SECRET.
 */
export async function authenticateWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.get(WEBHOOK_TOKEN_HEADER);
    if (!token) {
      logWebhookRejection(req, 'missing_token');
      res.status(401).json({ message: 'Missing webhook token' });
      return;
    }

    const record = await findActiveWebhookToken(token);
    if (!record) {
      logWebhookRejection(req, 'invalid_token');
      res.status(401).json({ message: 'Invalid webhook token' });
      return;
    }

    const signature = req.get(WEBHOOK_SIGNATURE_HEADER);
    if (signature) {
      if (!env.webhookSecret || !req.rawBody || !verifyWebhookSignature(req.rawBody, signature, env.webhookSecret)) {
        logWebhookRejection(req, 'invalid_signature', { organizationId: record.organizationId });
        res.status(401).json({ message: 'Invalid webhook signature' });
        return;
      }
    }

    req.webhook = { organizationId: record.organizationId, tokenId: record.id, userId: record.createdById };
    prisma.webhookToken.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
}
