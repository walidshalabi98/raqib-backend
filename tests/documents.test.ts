import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { createOrgFixture, hasTestDatabase, OrgFixture, PDF_BYTES, resetDatabase } from './helpers';

/** Turns an absolute signed URL from the API into a path supertest can request. */
function localPath(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

describe.skipIf(!hasTestDatabase)('document storage and access', () => {
  let a: OrgFixture;
  let b: OrgFixture;

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('a');
    b = await createOrgFixture('b');
  });

  it('no longer serves files from a public /uploads route', async () => {
    const res = await request(app).get('/uploads/anything.pdf');
    expect(res.status).toBe(404);
  });

  it('uploads to private storage and stores a storage key, not a public URL', async () => {
    const res = await request(app)
      .post(`/api/projects/${a.project.id}/documents`)
      .set('Authorization', a.officerAuth)
      .attach('file', PDF_BYTES, { filename: 'logframe.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.fileUrl).toMatch(new RegExp(`^projects/${a.project.id}/[0-9a-f-]+\\.pdf$`));
    expect(res.body.fileSizeBytes).toBe(PDF_BYTES.length);
  });

  it('returns a signed URL valid for 5 minutes to members of the owning organisation', async () => {
    const res = await request(app).get(`/api/documents/${a.document.id}/download`).set('Authorization', a.officerAuth);
    expect(res.status).toBe(200);
    expect(res.body.fileName).toBe('proposal.pdf');
    const ttl = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(5 * 60 * 1000);

    const file = await request(app).get(localPath(res.body.url)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(Buffer.compare(file.body, PDF_BYTES)).toBe(0);
    expect(file.headers['content-disposition']).toContain('proposal.pdf');
  });

  it('refuses the download without a session', async () => {
    const res = await request(app).get(`/api/documents/${a.document.id}/download`);
    expect(res.status).toBe(401);
  });

  it('refuses the download to another organisation', async () => {
    const res = await request(app).get(`/api/documents/${a.document.id}/download`).set('Authorization', b.officerAuth);
    expect(res.status).toBe(404);
  });

  it('rejects tampered, re-targeted and expired signed links', async () => {
    const res = await request(app).get(`/api/documents/${a.document.id}/download`).set('Authorization', a.officerAuth);
    const url = new URL(res.body.url);

    const tampered = new URL(url);
    tampered.searchParams.set('sig', '0'.repeat(64));
    expect((await request(app).get(localPath(tampered.toString()))).status).toBe(403);

    // Reusing A's signature for B's file must fail.
    const retargeted = new URL(url);
    retargeted.searchParams.set('key', b.document.fileUrl);
    expect((await request(app).get(localPath(retargeted.toString()))).status).toBe(403);

    const expired = new URL(url);
    expired.searchParams.set('exp', String(Math.floor(Date.now() / 1000) - 1));
    expect((await request(app).get(localPath(expired.toString()))).status).toBe(403);

    const traversal = new URL(url);
    traversal.searchParams.set('key', '../../etc/passwd');
    expect((await request(app).get(localPath(traversal.toString()))).status).toBe(403);
  });

  it('rejects unsupported types and files whose content does not match the extension', async () => {
    const exe = await request(app)
      .post(`/api/projects/${a.project.id}/documents`)
      .set('Authorization', a.officerAuth)
      .attach('file', Buffer.from('MZ fake'), { filename: 'tool.exe', contentType: 'application/octet-stream' });
    expect(exe.status).toBe(400);

    const fakePdf = await request(app)
      .post(`/api/projects/${a.project.id}/documents`)
      .set('Authorization', a.officerAuth)
      .attach('file', Buffer.from('<html>not a pdf</html>'), { filename: 'fake.pdf', contentType: 'application/pdf' });
    expect(fakePdf.status).toBe(400);
    expect(fakePdf.body.message).toMatch(/does not match/);
  });

  it('deletes the stored file with the document', async () => {
    const upload = await request(app)
      .post(`/api/projects/${a.project.id}/documents`)
      .set('Authorization', a.officerAuth)
      .attach('file', PDF_BYTES, { filename: 'temp.pdf', contentType: 'application/pdf' });
    const link = await request(app).get(`/api/documents/${upload.body.id}/download`).set('Authorization', a.officerAuth);

    const del = await request(app).delete(`/api/documents/${upload.body.id}`).set('Authorization', a.officerAuth);
    expect(del.status).toBe(200);
    expect(await prisma.document.findUnique({ where: { id: upload.body.id } })).toBeNull();
    expect((await request(app).get(localPath(link.body.url))).status).toBe(404);
  });
});
