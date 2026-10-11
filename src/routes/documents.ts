import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { assertDocumentAccess, assertProjectAccess } from '../middleware/access';
import { assertFileContent, documentUpload } from '../middleware/upload';
import { buildDocumentKey, getStorage, SIGNED_URL_TTL_SECONDS } from '../services/storage';
import { parseDocument } from '../services/ai/documentParser';

const router = Router();

// GET /api/projects/:id/documents
router.get('/projects/:id/documents', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const documents = await prisma.document.findMany({
    where: { projectId: req.params.id },
    include: { uploader: { select: { fullName: true } } },
    orderBy: { uploadedAt: 'desc' },
  });
  res.json(documents);
}));

// POST /api/projects/:id/documents — Upload document to private storage
router.post('/projects/:id/documents', authenticate, documentUpload.single('file'), asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);
  if (!req.file) throw new AppError(400, 'File is required');
  assertFileContent(req.file);

  const { fileType } = req.body;
  const key = buildDocumentKey(req.params.id, req.file.originalname);
  await getStorage().put(key, req.file.buffer, req.file.mimetype);

  const document = await prisma.document.create({
    data: {
      projectId: req.params.id,
      uploadedBy: req.user!.id,
      fileName: req.file.originalname,
      fileUrl: key, // storage key, not a public URL
      fileType: fileType || 'other',
      fileSizeBytes: req.file.size,
    },
  });

  // Parse document inline (no Redis needed)
  parseDocument(document.id).catch(err => {
    console.error(`[Documents] Background parsing failed for ${document.id}:`, err);
  });

  res.status(201).json(document);
}));

// GET /api/documents/:id/download — Short-lived signed URL, after an organisation check
router.get('/documents/:id/download', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const doc = await assertDocumentAccess(req, req.params.id);

  const url = await getStorage().signedUrl(doc.fileUrl, SIGNED_URL_TTL_SECONDS, doc.fileName);
  res.json({
    url,
    fileName: doc.fileName,
    expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  });
}));

// DELETE /api/documents/:id
router.delete('/documents/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const doc = await assertDocumentAccess(req, req.params.id);

  await prisma.document.delete({ where: { id: doc.id } });
  await getStorage().remove(doc.fileUrl).catch(err => {
    console.error(`[Documents] Could not delete stored file for ${doc.id}:`, err.message);
  });
  res.json({ message: 'Document deleted' });
}));

// GET /api/documents/:id/status
router.get('/documents/:id/status', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const doc = await assertDocumentAccess(req, req.params.id);
  res.json({ id: doc.id, parsingStatus: doc.parsingStatus });
}));

export default router;
