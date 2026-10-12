import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../src/app';
import { hasExpectedSignature, isAllowedUpload } from '../src/middleware/upload';
import { verifyWebhookSignature } from '../src/services/webhookTokens';
import crypto from 'crypto';

describe('security headers and CORS', () => {
  it('sends security headers', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows the app origin and refuses unknown origins', async () => {
    const allowed = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const refused = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('requires a session on protected routes', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(401);
  });
});

describe('upload validation', () => {
  it.each([
    ['report.pdf', 'application/pdf', true],
    ['logframe.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true],
    ['proposal.docx', 'application/octet-stream', true],
    ['old.doc', 'application/msword', false], // Word 97–2003: cannot be parsed, refused with advice
    ['old.doc', 'application/octet-stream', false],
    ['old.xls', 'application/vnd.ms-excel', false],
    ['script.js', 'application/javascript', false],
    ['image.pdf', 'image/png', false],
    ['noextension', 'application/pdf', false],
  ])('%s (%s) allowed: %s', (name, mime, allowed) => {
    expect(isAllowedUpload(name, mime)).toBe(allowed);
  });

  it('checks the file signature against the extension', () => {
    expect(hasExpectedSignature('a.pdf', Buffer.from('%PDF-1.7'))).toBe(true);
    expect(hasExpectedSignature('a.pdf', Buffer.from('PK\x03\x04'))).toBe(false);
    expect(hasExpectedSignature('a.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(true);
    expect(hasExpectedSignature('a.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1]))).toBe(false);
    expect(hasExpectedSignature('a.xlsx', Buffer.from('%PDF'))).toBe(false);
    expect(hasExpectedSignature('a.pdf', Buffer.from('%P'))).toBe(false);
  });
});

describe('webhook signature', () => {
  const body = Buffer.from('{"a":1}');
  const good = 'sha256=' + crypto.createHmac('sha256', 'secret').update(body).digest('hex');

  it('accepts a correct signature and rejects anything else', () => {
    expect(verifyWebhookSignature(body, good, 'secret')).toBe(true);
    expect(verifyWebhookSignature(body, good.toUpperCase().replace('SHA256', 'sha256'), 'secret')).toBe(true);
    expect(verifyWebhookSignature(Buffer.from('{"a":2}'), good, 'secret')).toBe(false);
    expect(verifyWebhookSignature(body, good, 'other-secret')).toBe(false);
    expect(verifyWebhookSignature(body, 'sha256=abc', 'secret')).toBe(false);
    expect(verifyWebhookSignature(body, good.replace('sha256=', ''), 'secret')).toBe(false);
  });
});
