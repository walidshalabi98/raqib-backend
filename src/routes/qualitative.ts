import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { codeQualitativeEntry } from '../services/ai/qualitativeCoder';
import { parseDocument } from '../services/ai/documentParser';

// Multer for qualitative document uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(process.cwd(), 'uploads', 'qualitative');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();

// GET /api/projects/:id/qualitative
router.get('/projects/:id/qualitative', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const entries = await prisma.qualitativeEntry.findMany({
    where: { projectId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json(entries);
}));

// POST /api/projects/:id/qualitative — Add entry
router.post('/projects/:id/qualitative', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const {
    entryType, title, content, participants, location,
    dateConducted, facilitator, assessmentId, attachments,
  } = req.body;

  if (!entryType || !title || !content) {
    throw new AppError(400, 'entryType, title, and content are required');
  }

  const entry = await prisma.qualitativeEntry.create({
    data: {
      projectId: req.params.id,
      entryType,
      title,
      content,
      participants,
      location,
      dateConducted: dateConducted ? new Date(dateConducted) : undefined,
      facilitator,
      assessmentId,
      attachments,
    },
  });

  // Auto-trigger AI thematic coding after creation
  codeQualitativeEntry(entry.id, req.params.id).catch(err => {
    console.error('Auto-coding qualitative entry failed:', err.message);
  });

  res.status(201).json(entry);
}));

// POST /api/projects/:id/qualitative/upload — Upload document (transcript/notes) and create qualitative entry
router.post('/projects/:id/qualitative/upload', authenticate, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const file = req.file;
  if (!file) throw new AppError(400, 'No file uploaded');

  const { entryType, title, participants, location, dateConducted, facilitator } = req.body;

  // 1. Create a document record for parsing
  const document = await prisma.document.create({
    data: {
      projectId: req.params.id,
      uploadedBy: req.user!.id,
      fileName: file.originalname,
      fileUrl: `/uploads/qualitative/${file.filename}`,
      fileType: 'other',
      fileSizeBytes: file.size,
      parsingStatus: 'pending',
    },
  });

  // 2. Parse the document to extract text
  parseDocument(document.id).then(async () => {
    // 3. After parsing, create a qualitative entry with the parsed text
    const parsedDoc = await prisma.document.findUnique({ where: { id: document.id } });
    const content = parsedDoc?.parsedText || `[Content from uploaded file: ${file.originalname}]`;

    // Strip AI analysis marker from content for the qualitative entry
    const aiMarker = '---AI_ANALYSIS---';
    const cleanContent = content.includes(aiMarker) ? content.substring(0, content.indexOf(aiMarker)).trim() : content;

    const entry = await prisma.qualitativeEntry.create({
      data: {
        projectId: req.params.id,
        entryType: entryType || 'fgd_transcript',
        title: title || `Transcript: ${file.originalname}`,
        content: cleanContent,
        participants: participants ? parseInt(participants) : undefined,
        location,
        dateConducted: dateConducted ? new Date(dateConducted) : undefined,
        facilitator,
        attachments: [{ documentId: document.id, fileName: file.originalname }],
      },
    });

    // 4. Auto-trigger AI thematic coding
    codeQualitativeEntry(entry.id, req.params.id).catch(err => {
      console.error('Qualitative coding after upload failed:', err.message);
    });

    console.log(`[Qualitative] Created entry from uploaded doc: ${file.originalname}`);
  }).catch(err => {
    console.error('Document parsing for qualitative failed:', err.message);
  });

  res.status(202).json({
    documentId: document.id,
    status: 'processing',
    message: 'Document is being parsed and analyzed. A qualitative entry will be created automatically.',
  });
}));

// GET /api/qualitative/:id — Get full entry with themes
router.get('/qualitative/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const entry = await prisma.qualitativeEntry.findUnique({
    where: { id: req.params.id },
    include: { project: true, assessment: true },
  });

  if (!entry || entry.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Entry not found');
  }

  res.json(entry);
}));

// POST /api/qualitative/:id/code — Trigger AI thematic coding
router.post('/qualitative/:id/code', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const entry = await prisma.qualitativeEntry.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });

  if (!entry || entry.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Entry not found');
  }

  // Thematic coding runs inline (no Redis/BullMQ needed)
  codeQualitativeEntry(req.params.id, entry.projectId).catch(err => {
    console.error('Qualitative coding failed:', err.message);
  });

  res.status(202).json({ entryId: req.params.id, status: 'processing' });
}));

export default router;
