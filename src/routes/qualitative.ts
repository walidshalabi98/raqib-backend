import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { assertAssessmentInProject, assertProjectAccess, assertQualitativeAccess } from '../middleware/access';
import { aiLimiter } from '../middleware/rateLimit';
import { assertFileContent, documentUpload } from '../middleware/upload';
import { buildDocumentKey, getStorage } from '../services/storage';
import { codeQualitativeEntry } from '../services/ai/qualitativeCoder';
import { parseDocument } from '../services/ai/documentParser';
import { safeErrorSummary } from '../services/ai/errors';

const router = Router();

// GET /api/projects/:id/qualitative
router.get('/projects/:id/qualitative', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const entries = await prisma.qualitativeEntry.findMany({
    where: { projectId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json(entries);
}));

// POST /api/projects/:id/qualitative — Add entry
router.post('/projects/:id/qualitative', authenticate, aiLimiter, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const {
    entryType, title, content, participants, location,
    dateConducted, facilitator, assessmentId, attachments,
  } = req.body;

  if (!entryType || !title || !content) {
    throw new AppError(400, 'entryType, title, and content are required');
  }
  await assertAssessmentInProject(req.params.id, assessmentId);

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
    console.error(`Auto-coding qualitative entry ${entry.id} failed: ${safeErrorSummary(err)}`);
  });

  res.status(201).json(entry);
}));

// POST /api/projects/:id/qualitative/upload — Upload document (transcript/notes) and create qualitative entry
router.post('/projects/:id/qualitative/upload', authenticate, aiLimiter, documentUpload.single('file'), asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const file = req.file;
  if (!file) throw new AppError(400, 'No file uploaded');
  assertFileContent(file);

  const key = buildDocumentKey(req.params.id, file.originalname);
  await getStorage().put(key, file.buffer, file.mimetype);

  const { entryType, title, participants, location, dateConducted, facilitator } = req.body;

  // 1. Create a document record for parsing
  const document = await prisma.document.create({
    data: {
      projectId: req.params.id,
      uploadedBy: req.user!.id,
      fileName: file.originalname,
      fileUrl: key, // storage key, not a public URL
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
      console.error(`Qualitative coding after upload failed for entry ${entry.id}: ${safeErrorSummary(err)}`);
    });

    // Log ids only: file names can hold personal data.
    console.log(`[Qualitative] Created entry ${entry.id} from uploaded document ${document.id}`);
  }).catch(err => {
    console.error(`Document parsing for qualitative failed for document ${document.id}: ${safeErrorSummary(err)}`);
  });

  res.status(202).json({
    documentId: document.id,
    status: 'processing',
    message: 'Document is being parsed and analyzed. A qualitative entry will be created automatically.',
  });
}));

// GET /api/qualitative/:id — Get full entry with themes
router.get('/qualitative/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const entry = await assertQualitativeAccess(req, req.params.id);

  res.json(entry);
}));

// POST /api/qualitative/:id/code — Trigger AI thematic coding
router.post('/qualitative/:id/code', authenticate, aiLimiter, asyncHandler(async (req: Request, res: Response) => {
  const entry = await assertQualitativeAccess(req, req.params.id);

  // Thematic coding runs inline (no Redis/BullMQ needed)
  codeQualitativeEntry(req.params.id, entry.projectId).catch(err => {
    console.error(`Qualitative coding failed for entry ${req.params.id}: ${safeErrorSummary(err)}`);
  });

  res.status(202).json({ entryId: req.params.id, status: 'processing' });
}));

export default router;
