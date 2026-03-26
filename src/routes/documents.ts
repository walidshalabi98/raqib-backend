import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { parseDocument } from '../services/ai/documentParser';

const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.xlsx', '.xls', '.doc'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Unsupported file type'));
  },
});

const router = Router();

// GET /api/projects/:id/documents
router.get('/projects/:id/documents', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const documents = await prisma.document.findMany({
    where: { projectId: req.params.id },
    include: { uploader: { select: { fullName: true } } },
    orderBy: { uploadedAt: 'desc' },
  });
  res.json(documents);
}));

// POST /api/projects/:id/documents — Upload document
router.post('/projects/:id/documents', authenticate, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');
  if (!req.file) throw new AppError(400, 'File is required');

  const { fileType } = req.body;

  const document = await prisma.document.create({
    data: {
      projectId: req.params.id,
      uploadedBy: req.user!.id,
      fileName: req.file.originalname,
      fileUrl: `/uploads/${req.file.filename}`,
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

// DELETE /api/documents/:id
router.delete('/documents/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const doc = await prisma.document.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!doc || doc.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Document not found');
  }

  // Delete file from disk
  const filePath = path.join(process.cwd(), doc.fileUrl);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  await prisma.document.delete({ where: { id: req.params.id } });
  res.json({ message: 'Document deleted' });
}));

// GET /api/documents/:id/status
router.get('/documents/:id/status', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const doc = await prisma.document.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!doc || doc.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Document not found');
  }

  res.json({ id: doc.id, parsingStatus: doc.parsingStatus });
}));

export default router;
