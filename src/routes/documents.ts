import { Router, Request, Response } from 'express';
import { DocumentType, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { hasStaffRole, STAFF_ROLES } from '../middleware/roles';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { assertDocumentAccess, assertProjectAccess } from '../middleware/access';
import { assertFileContent, documentUpload } from '../middleware/upload';
import { buildDocumentKey, getStorage, SIGNED_URL_TTL_SECONDS } from '../services/storage';
import { parseDocument } from '../services/ai/documentParser';
import { safeErrorSummary } from '../services/ai/errors';
import { donorCanSeeDocument, donorDocumentWhere, toDonorDocument } from '../services/privacy/donorView';

const router = Router();

/**
 * The document fields the API returns. Never parsedText (the extracted text: the app does not need
 * it, and rows parsed before Phase 3 are not redacted) or fileUrl (the private storage key; files
 * are served through GET /documents/:id/download). `textLength` is added from the database.
 */
export const DOCUMENT_FIELDS = {
  id: true,
  projectId: true,
  fileName: true,
  fileType: true,
  fileSizeBytes: true,
  parsingStatus: true,
  uploadedAt: true,
  aiAnalysis: true,
  qualitativeSource: true,
  uploader: { select: { fullName: true } },
} satisfies Prisma.DocumentSelect;

/**
 * Adds `textLength` (characters of extracted text, 0 when none) to documents selected with
 * DOCUMENT_FIELDS, without loading the text. Pass only documents the user may see.
 */
export async function withTextLength<T extends { id: string }>(documents: T[]): Promise<(T & { textLength: number })[]> {
  if (documents.length === 0) return [];
  const rows = await prisma.$queryRaw<{ id: string; textLength: number }[]>`
    SELECT "id", COALESCE(length("parsedText"), 0)::int AS "textLength"
    FROM "Document"
    WHERE "id" IN (${Prisma.join(documents.map(d => d.id))})`;
  const lengths = new Map(rows.map(r => [r.id, Number(r.textLength)]));
  return documents.map(d => ({ ...d, textLength: lengths.get(d.id) ?? 0 }));
}

// GET /api/projects/:id/documents — display fields, textLength and aiAnalysis (Document.aiAnalysis, or null).
// Transcripts uploaded through the qualitative upload (qualitativeSource: true) are listed but never analysed.
// Donor viewers (any role without staff rights) see donor-facing document types only, without the AI analysis
// or the uploader's name (SECURITY_SETUP §8.3).
router.get('/projects/:id/documents', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const documents = await withTextLength(await prisma.document.findMany({
    where: { projectId: req.params.id, ...donorDocumentWhere(req.user) },
    select: DOCUMENT_FIELDS,
    orderBy: { uploadedAt: 'desc' },
  }));
  // Donor viewers: no AI analysis (not reviewed) and no uploader names.
  res.json(hasStaffRole(req.user) ? documents : documents.map(toDonorDocument));
}));

// POST /api/projects/:id/documents — Upload document to private storage (staff only; refused before the file is read)
router.post('/projects/:id/documents', authenticate, authorize(...STAFF_ROLES), documentUpload.single('file'), asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);
  if (!req.file) throw new AppError(400, 'File is required');
  assertFileContent(req.file);

  const fileType = req.body.fileType || 'other';
  if (!(Object.values(DocumentType) as string[]).includes(fileType)) {
    throw new AppError(400, `fileType must be one of: ${Object.values(DocumentType).join(', ')}`);
  }
  const key = buildDocumentKey(req.params.id, req.file.originalname);
  await getStorage().put(key, req.file.buffer, req.file.mimetype);

  const document = await prisma.document.create({
    data: {
      projectId: req.params.id,
      uploadedBy: req.user!.id,
      fileName: req.file.originalname,
      fileUrl: key, // storage key, not a public URL
      fileType: fileType as DocumentType,
      fileSizeBytes: req.file.size,
    },
    select: DOCUMENT_FIELDS,
  });

  // Parse document inline (no Redis needed). parseDocument logs the cause without document content.
  parseDocument(document.id).catch(() => {
    console.error(`[Documents] Background parsing failed for ${document.id}`);
  });

  res.status(201).json({ ...document, textLength: 0 });
}));

// GET /api/documents/:id/download — Short-lived signed URL, after an organisation check.
// Documents hidden from donor viewers answer 404, like another organisation's id, so types cannot be probed.
router.get('/documents/:id/download', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const doc = await assertDocumentAccess(req, req.params.id);
  if (!hasStaffRole(req.user) && !donorCanSeeDocument(doc)) throw new AppError(404, 'Document not found');

  const url = await getStorage().signedUrl(doc.fileUrl, SIGNED_URL_TTL_SECONDS, doc.fileName);
  res.json({
    url,
    fileName: doc.fileName,
    expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  });
}));

// DELETE /api/documents/:id (staff only)
router.delete('/documents/:id', authenticate, authorize(...STAFF_ROLES), asyncHandler(async (req: Request, res: Response) => {
  const doc = await assertDocumentAccess(req, req.params.id);

  await prisma.document.delete({ where: { id: doc.id } });
  await getStorage().remove(doc.fileUrl).catch(err => {
    console.error(`[Documents] Could not delete stored file for ${doc.id}: ${safeErrorSummary(err)}`);
  });
  res.json({ message: 'Document deleted' });
}));

// GET /api/documents/:id/status
router.get('/documents/:id/status', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const doc = await assertDocumentAccess(req, req.params.id);
  if (!hasStaffRole(req.user) && !donorCanSeeDocument(doc)) throw new AppError(404, 'Document not found');
  res.json({ id: doc.id, parsingStatus: doc.parsingStatus });
}));

export default router;
