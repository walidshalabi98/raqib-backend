import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { hasStaffRole, STAFF_ROLES } from '../middleware/roles';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { assertAssessmentInProject, assertProjectAccess, assertQualitativeAccess } from '../middleware/access';
import { aiLimiter } from '../middleware/rateLimit';
import { assertFileContent, documentUpload } from '../middleware/upload';
import { buildDocumentKey, storeUploadedFile } from '../services/storage';
import { codeQualitativeEntry } from '../services/ai/qualitativeCoder';
import { parseDocument } from '../services/ai/documentParser';
import { safeErrorSummary } from '../services/ai/errors';
import { redactPersonalData } from '../services/ai/redact';
import { describeRedactions, redactQualitativeFields, redactionTotal } from '../services/qualitative/redactEntry';
import { dateOf, EntryFieldError, entryTypeOf, participantsOf } from '../services/qualitative/entryFields';
import { toDonorQualitativeEntry } from '../services/privacy/donorView';

const router = Router();

/** Optional text fields of an entry: absent (undefined or null) or text. Checked before anything is stored. */
function assertOptionalText(body: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    const value = body[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new AppError(400, `${field} must be text`);
    }
  }
}

/** Runs a field check from entryFields and turns its error into a 400. */
function checked<T>(check: () => T): T {
  try {
    return check();
  } catch (err) {
    if (err instanceof EntryFieldError) throw new AppError(400, err.message);
    throw err;
  }
}

// GET /api/projects/:id/qualitative — staff get full entries; donor viewers get type, month and participants only
// (no title, content, facilitator, location, attachments, exact date or AI coding: SECURITY_SETUP §8.3).
router.get('/projects/:id/qualitative', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const entries = await prisma.qualitativeEntry.findMany({
    where: { projectId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json(hasStaffRole(req.user) ? entries : entries.map(toDonorQualitativeEntry));
}));

// POST /api/projects/:id/qualitative — Add entry (staff only: write and AI coding)
router.post('/projects/:id/qualitative', authenticate, authorize(...STAFF_ROLES), aiLimiter, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const {
    entryType, title, content, participants, location,
    dateConducted, facilitator, assessmentId, attachments,
  } = req.body;

  if (!entryType || !title || !content) {
    throw new AppError(400, 'entryType, title, and content are required');
  }
  if (typeof title !== 'string' || typeof content !== 'string') {
    throw new AppError(400, 'title and content must be text');
  }
  assertOptionalText(req.body, ['location', 'facilitator']);
  // Checked here: a value the database refuses would put the whole entry in its error message.
  const type = checked(() => entryTypeOf(entryType, 'entryType'));
  const participantCount = checked(() => participantsOf(participants));
  const conductedOn = checked(() => dateOf(dateConducted, 'dateConducted'));
  await assertAssessmentInProject(req.params.id, assessmentId);

  // Typed notes are stored without phone numbers, ID numbers or email addresses (CLAUDE.md rule 5).
  const { values: text, counts } = redactQualitativeFields({ title, content, location, facilitator });

  const entry = await prisma.qualitativeEntry.create({
    data: {
      projectId: req.params.id,
      entryType: type,
      title: text.title,
      content: text.content,
      participants: participantCount,
      location: text.location,
      dateConducted: conductedOn,
      facilitator: text.facilitator,
      assessmentId,
      attachments,
    },
  });
  // Ids and counts only: never the text.
  if (redactionTotal(counts) > 0) console.log(`[Qualitative] Entry ${entry.id}: ${describeRedactions(counts)}`);

  // Auto-trigger AI thematic coding after creation
  codeQualitativeEntry(entry.id, req.params.id).catch(err => {
    console.error(`Auto-coding qualitative entry ${entry.id} failed: ${safeErrorSummary(err)}`);
  });

  res.status(201).json({ ...entry, redactions: counts });
}));

// POST /api/projects/:id/qualitative/upload — Upload document (transcript/notes) and create qualitative entry
// (staff only: refused before the limiter counts it and before the file is read)
router.post('/projects/:id/qualitative/upload', authenticate, authorize(...STAFF_ROLES), aiLimiter, documentUpload.single('file'), asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const file = req.file;
  if (!file) throw new AppError(400, 'No file uploaded');
  assertFileContent(file);
  // A repeated form field arrives as a list: refuse it before the file is stored.
  assertOptionalText(req.body, ['title', 'location', 'facilitator']);
  // Checked before the file is stored: the entry is created after parsing, when the request has been answered.
  const type = checked(() => entryTypeOf(req.body.entryType, 'entryType', 'fgd_transcript'));
  const participantCount = checked(() => participantsOf(req.body.participants));
  const conductedOn = checked(() => dateOf(req.body.dateConducted, 'dateConducted'));

  const key = buildDocumentKey(req.params.id, file.originalname);
  const { title, location, facilitator } = req.body;

  // 1. A document record for the transcript. qualitativeSource: it is coded with its qualitative entry
  // only, and never sent to document analysis, framework generation or assessment summaries. The stored file
  // is removed again if the record cannot be saved (the project was deleted meanwhile).
  const document = await storeUploadedFile({ key, body: file.buffer, contentType: file.mimetype, projectId: req.params.id }, () => (
    prisma.document.create({
      data: {
        projectId: req.params.id,
        uploadedBy: req.user!.id,
        fileName: file.originalname,
        fileUrl: key, // storage key, not a public URL
        fileType: 'other',
        fileSizeBytes: file.size,
        parsingStatus: 'pending',
        qualitativeSource: true,
      },
    })
  ));

  // File names can hold phone or ID numbers: the entry's title and placeholder content use a redacted name.
  const safeFileName = redactPersonalData(file.originalname).text;

  // 2. Parse the document to extract its text (parseDocument stores only redacted text)
  parseDocument(document.id).then(async () => {
    // 3. After parsing, create a qualitative entry with the parsed text. parsedText is the transcript
    // as just extracted and redacted: there is no appended AI analysis to cut off.
    const parsedDoc = await prisma.document.findUnique({ where: { id: document.id }, select: { parsedText: true } });
    const content = parsedDoc?.parsedText?.trim() ? parsedDoc.parsedText : `[Content from uploaded file: ${safeFileName}]`;
    // The typed title, location and facilitator are redacted like typed notes; the content again, which
    // changes nothing in text the parser already redacted.
    const { values: text, counts } = redactQualitativeFields({ title: title || `Transcript: ${safeFileName}`, content, location, facilitator });

    const entry = await prisma.qualitativeEntry.create({
      data: {
        projectId: req.params.id,
        entryType: type,
        title: text.title,
        content: text.content,
        participants: participantCount,
        location: text.location,
        dateConducted: conductedOn,
        facilitator: text.facilitator,
        attachments: [{ documentId: document.id, fileName: file.originalname }],
      },
    });

    // 4. Auto-trigger AI thematic coding
    codeQualitativeEntry(entry.id, req.params.id).catch(err => {
      console.error(`Qualitative coding after upload failed for entry ${entry.id}: ${safeErrorSummary(err)}`);
    });

    // Log ids and counts only: file names can hold personal data.
    const removed = redactionTotal(counts) > 0 ? ` (${describeRedactions(counts)})` : '';
    console.log(`[Qualitative] Created entry ${entry.id} from uploaded document ${document.id}${removed}`);
  }).catch(err => {
    console.error(`Document parsing for qualitative failed for document ${document.id}: ${safeErrorSummary(err)}`);
  });

  res.status(202).json({
    documentId: document.id,
    status: 'processing',
    message: 'The transcript is being read. A qualitative entry will be created and coded automatically.',
  });
}));

// GET /api/qualitative/:id — Get full entry with themes (donor viewers: type, month and participants only)
router.get('/qualitative/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const entry = await assertQualitativeAccess(req, req.params.id);

  res.json(hasStaffRole(req.user) ? entry : toDonorQualitativeEntry(entry));
}));

// POST /api/qualitative/:id/code — Trigger AI thematic coding (staff only)
router.post('/qualitative/:id/code', authenticate, authorize(...STAFF_ROLES), aiLimiter, asyncHandler(async (req: Request, res: Response) => {
  const entry = await assertQualitativeAccess(req, req.params.id);

  // Thematic coding runs inline (no Redis/BullMQ needed)
  codeQualitativeEntry(req.params.id, entry.projectId).catch(err => {
    console.error(`Qualitative coding failed for entry ${req.params.id}: ${safeErrorSummary(err)}`);
  });

  res.status(202).json({ entryId: req.params.id, status: 'processing' });
}));

export default router;
