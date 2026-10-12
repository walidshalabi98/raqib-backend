import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { getStorage } from '../storage';
import { generateStructured } from './client';
import { AiError } from './errors';
import { redactPersonalData } from './redact';
import {
  DOCUMENT_ANALYSIS_PROMPT_VERSION,
  DOCUMENT_ANALYSIS_SCHEMA,
  DOCUMENT_ANALYSIS_SYSTEM,
  DocumentAnalysisAnswer,
  documentAnalysisPrompt,
  StoredDocumentAnalysis,
} from './prompts/documentAnalysis';

/** Documents with less text than this (after redaction) are not sent for AI analysis. */
const MIN_TEXT_FOR_ANALYSIS = 50;

/**
 * Extracts the text of an uploaded document (PDF, Word, Excel; OCR for scanned PDFs), removes
 * phone numbers, ID numbers and email addresses, and stores it in Document.parsedText. Then asks
 * the model for an analysis, stored in Document.aiAnalysis. An AI failure is logged and does not
 * fail parsing. Logs hold ids and counts only, never document text or model output.
 */
export async function parseDocument(documentId: string): Promise<void> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    include: { project: { select: { organizationId: true } } },
  });
  if (!doc) throw new Error(`Document ${documentId} not found`);

  await prisma.document.update({
    where: { id: documentId },
    data: { parsingStatus: 'processing' },
  });

  let text: string;
  try {
    const buffer = await getStorage().get(doc.fileUrl);

    const ext = path.extname(doc.fileName).toLowerCase();
    let raw = '';

    if (ext === '.pdf') {
      raw = await parsePdf(buffer);
    } else if (ext === '.docx' || ext === '.doc') {
      raw = await parseDocx(buffer);
    } else if (ext === '.xlsx') {
      raw = await parseExcel(buffer);
    } else {
      throw new UnsupportedFileTypeError(ext);
    }

    // If PDF parsing returned very little text, try OCR
    if (ext === '.pdf' && raw.trim().length < 100) {
      console.log(`[DocumentParser] Low text content, attempting OCR for document ${documentId}`);
      raw = await ocrPdf(buffer);
    }

    // Only redacted text is stored or sent to a model (CLAUDE.md rule 5).
    const redacted = redactPersonalData(raw);
    text = redacted.text;
    const { phone, idNumber, email } = redacted.counts;

    await prisma.document.update({
      where: { id: documentId },
      data: {
        parsedText: text,
        aiAnalysis: Prisma.DbNull, // an earlier analysis belongs to the earlier text
        parsingStatus: 'completed',
      },
    });
    console.log(`[DocumentParser] Parsed document ${documentId} (${text.length} chars; removed ${phone} phone numbers, ${idNumber} ID numbers, ${email} email addresses)`);
  } catch (error) {
    console.error(`[DocumentParser] Failed to parse document ${documentId}: ${describeError(error)}`);
    await prisma.document.update({
      where: { id: documentId },
      data: { parsingStatus: 'failed' },
    });
    throw error;
  }

  if (text.trim().length > MIN_TEXT_FOR_ANALYSIS) {
    await analyseDocument(documentId, doc.fileName, text, { organizationId: doc.project.organizationId, projectId: doc.projectId });
  }
}

/** Asks the model for the document analysis and stores it; never throws. */
async function analyseDocument(
  documentId: string,
  fileName: string,
  redactedText: string,
  context: { organizationId: string; projectId: string },
): Promise<void> {
  try {
    const result = await generateStructured({
      feature: 'document.analysis',
      model: 'fast',
      effort: 'low',
      system: DOCUMENT_ANALYSIS_SYSTEM,
      // documentAnalysisPrompt sends at most the first 12 000 characters of the redacted text.
      messages: [{ role: 'user', content: documentAnalysisPrompt(redactedText, fileName) }],
      schema: DOCUMENT_ANALYSIS_SCHEMA,
      promptVersion: DOCUMENT_ANALYSIS_PROMPT_VERSION,
      maxTokens: 4000,
      context,
    });

    const analysis: StoredDocumentAnalysis = {
      ...normalizeDocumentAnalysis(result.data),
      model: result.model,
      promptVersion: result.promptVersion || DOCUMENT_ANALYSIS_PROMPT_VERSION,
      analysedAt: new Date().toISOString(),
    };
    await prisma.document.update({
      where: { id: documentId },
      data: { aiAnalysis: analysis as unknown as Prisma.InputJsonObject },
    });
    console.log(`[DocumentParser] AI analysis stored for document ${documentId} (${result.model}; ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens)`);
  } catch (error) {
    // AI errors carry safe messages (errors.ts); anything else is reported by name only.
    const cause = error instanceof AiError ? describeError(error) : error instanceof Error ? error.name : 'unknown error';
    console.error(`[DocumentParser] AI analysis failed for document ${documentId}: ${cause}`);
  }
}

const MAX_TEXT_LENGTH = 2000;
const MAX_LIST_ITEMS = 20;

/**
 * Tidies the model's answer before it is stored: trims text, drops empty entries, caps lengths
 * and list sizes, and removes any phone number, ID number or email address the model wrote anyway.
 */
export function normalizeDocumentAnalysis(data: DocumentAnalysisAnswer): DocumentAnalysisAnswer {
  const clean = (value: string): string => redactPersonalData((value ?? '').trim()).text.slice(0, MAX_TEXT_LENGTH);
  const list = (values: string[]): string[] => (values ?? []).map(clean).filter(Boolean).slice(0, MAX_LIST_ITEMS);
  return {
    documentType: data.documentType,
    summary: clean(data.summary),
    keyFindings: list(data.keyFindings),
    indicatorsMentioned: list(data.indicatorsMentioned),
    targetsMentioned: (data.targetsMentioned ?? [])
      .map(t => ({ indicator: clean(t.indicator), target: clean(t.target), timeline: clean(t.timeline) }))
      .filter(t => t.indicator || t.target)
      .slice(0, MAX_LIST_ITEMS),
    recommendations: list(data.recommendations),
  };
}

class UnsupportedFileTypeError extends Error {
  constructor(ext: string) {
    super(`Unsupported file type: ${ext || '(none)'}`);
    this.name = 'UnsupportedFileTypeError';
  }
}

/**
 * A log line for an error without document content: AI errors and our own errors carry safe
 * messages; database errors can echo the data they were given, so only their name and code are kept.
 */
function describeError(error: unknown): string {
  if (error instanceof AiError || error instanceof UnsupportedFileTypeError) return `${error.name}: ${error.message}`;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (error.name.startsWith('PrismaClient')) return `${error.name}${typeof code === 'string' ? ` (${code})` : ''}`;
    return `${error.name}: ${error.message.split('\n')[0].slice(0, 200)}`;
  }
  return 'unknown error';
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const pdfParse = (await import('pdf-parse')).default;
  const data = await pdfParse(buffer);
  return data.text;
}

async function parseDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function parseExcel(buffer: Buffer): Promise<string> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const texts: string[] = [];

  workbook.eachSheet(sheet => {
    const rows: string[] = [];
    sheet.eachRow(row => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, cell => cells.push(csvEscape(cellText(cell.value))));
      rows.push(cells.join(','));
    });
    texts.push(`--- Sheet: ${sheet.name} ---\n${rows.join('\n')}`);
  });

  return texts.join('\n\n');
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().split('T')[0];
  if (typeof value === 'object') {
    const v = value as { result?: unknown; text?: unknown; richText?: { text: string }[]; error?: string };
    if (v.richText) return v.richText.map(r => r.text).join('');
    if (v.text !== undefined) return cellText(v.text);
    if (v.result !== undefined) return cellText(v.result);
    if (v.error) return v.error;
  }
  return String(value);
}

function csvEscape(text: string): string {
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function ocrPdf(buffer: Buffer): Promise<string> {
  try {
    const Tesseract = await import('tesseract.js');
    // For OCR, we'd typically convert PDF pages to images first.
    // Simplified: attempt Tesseract on the file directly (works for image-based PDFs)
    const { data } = await Tesseract.recognize(buffer, 'eng+ara');
    return data.text;
  } catch (error) {
    console.warn(`[DocumentParser] OCR failed, returning empty text: ${describeError(error)}`);
    return '';
  }
}

/**
 * Chunk text into segments for embedding/LLM processing (consecutive chunks share `overlap` characters).
 */
export function chunkText(text: string, chunkSize = 2000, overlap = 200): string[] {
  const chunks: string[] = [];
  const size = Math.max(1, Math.floor(chunkSize));
  const step = Math.max(1, size - Math.max(0, Math.floor(overlap)));
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start += step;
  }

  return chunks;
}
