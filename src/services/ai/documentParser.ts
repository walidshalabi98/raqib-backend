import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { getStorage } from '../storage';
import { generateStructured } from './client';
import { AiError } from './errors';
import { appearsInDocuments } from './frameworkNormalize';
import { redactPersonalData } from './redact';
import {
  DOCUMENT_ANALYSIS_PROMPT_VERSION,
  DOCUMENT_ANALYSIS_SCHEMA,
  DOCUMENT_ANALYSIS_SYSTEM,
  DocumentAnalysisAnswer,
  documentAnalysisPrompt,
  StoredDocumentAnalysis,
  VerifiedDocumentAnalysis,
} from './prompts/documentAnalysis';

/** Documents with less text than this (after redaction) are not sent for AI analysis. */
const MIN_TEXT_FOR_ANALYSIS = 50;

/**
 * Extracts the text of an uploaded document (PDF, Word .docx, Excel .xlsx; OCR for scanned PDFs),
 * removes phone numbers, ID numbers and email addresses, and stores it in Document.parsedText. Then
 * asks the model for an analysis, stored in Document.aiAnalysis with its figures checked against the
 * text. Qualitative transcripts (Document.qualitativeSource) are parsed and redacted the same way but
 * never analysed: they are coded with their qualitative entry only. An AI failure is logged and does
 * not fail parsing. Logs hold ids and counts only, never document text or model output.
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
    } else if (ext === '.docx') {
      // Word 97–2003 (.doc) files cannot be read (mammoth reads .docx only); uploads refuse them.
      raw = await parseDocx(buffer);
    } else if (ext === '.xlsx') {
      raw = await parseExcel(buffer);
    } else {
      throw new UnsupportedFileTypeError(ext);
    }

    // If PDF parsing returned very little text, try OCR (and keep the extracted text if OCR finds less)
    if (ext === '.pdf' && raw.trim().length < 100) {
      console.log(`[DocumentParser] Low text content, attempting OCR for document ${documentId}`);
      const ocr = await ocrPdf(buffer);
      if (ocr.trim().length > raw.trim().length) raw = ocr;
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

  if (doc.qualitativeSource) {
    console.log(`[DocumentParser] Document ${documentId} is a qualitative transcript: not sent for document analysis`);
    return;
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
      ...verifyDocumentAnalysis(normalizeDocumentAnalysis(result.data), redactedText),
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

// ------------------------------------------------- figures checked against the document

const MAX_UNVERIFIED_FIGURES = 20;

/**
 * Numbers written in a text: ASCII or Arabic-Indic digits, with thousands separators, decimals (point
 * or comma) and a percent sign ("1,200", "12.5", "12,5", "45%", "٤٥٪", "١٬٢٠٠").
 */
const FIGURE = /(?<![\p{Nd}.,\u066B\u066C])\p{Nd}+(?:[,\u066C]\p{Nd}{3})*(?:[.,\u066B]\p{Nd}+)?(?:\s?[%\u066A])?/gu;

function asciiDigits(value: string): string {
  return value.replace(/\p{Nd}/gu, d => {
    const code = d.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
    if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
    return d;
  });
}

/**
 * The ways a figure may be written in the document: with or without thousands separators, with a
 * decimal point or comma, with ASCII or Arabic separators and percent sign ("١٬٢٠٠" and "٤٥٪" are
 * matched as "1٬200" and "45٪": appearsInDocuments converts only the digits).
 */
function figureForms(figure: string): string[] {
  const ascii = asciiDigits(figure).replace(/\u066C/g, ',').replace(/\u066B/g, '.').replace(/\u066A/g, '%').replace(/\s+/g, '');
  const forms = new Set([figure, ascii]);
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:[.,](\d+))?(%?)$/.exec(ascii);
  if (match) {
    const [, whole, decimals, percent] = match;
    const plain = whole.replace(/,/g, '');
    for (const integer of [plain, plain.replace(/\B(?=(\d{3})+(?!\d))/g, ',')]) {
      for (const fraction of decimals === undefined ? [''] : [`.${decimals}`, `,${decimals}`]) forms.add(integer + fraction + percent);
    }
  }
  for (const form of [...forms]) forms.add(form.replace(/,/g, '\u066C').replace(/%/g, '\u066A'));
  return [...forms];
}

/** Years (1900–2100) and single-digit counts are not checked: they are rarely invented and often written as words. */
function worthChecking(figure: string): boolean {
  const ascii = asciiDigits(figure).replace(/\u066A/g, '%');
  if (/[%.\u066B]/.test(ascii)) return true;
  const value = Number(ascii.replace(/[,\u066C\s]/g, ''));
  return !(value >= 1900 && value <= 2100) && value >= 10;
}

/** The first run of digits (with separators inside it) of a value: "1,200" in "1,200 households", "22" in "22%". */
const FIGURE_CORE = /\d(?:[\d,.\u066C]*\d)?/;

const normalisePhrase = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * String matching against one document's redacted text (CLAUDE.md rule 6), with the semantics of
 * appearsInDocuments (frameworkNormalize.ts): ignoring case, repeated spaces and Arabic-Indic digits,
 * and never inside a larger number. To stay fast on long documents, the text is scanned for the
 * value's digits and appearsInDocuments runs on a short window around each occurrence.
 */
function documentMatcher(text: string) {
  // Same length as `text`, so positions found here are positions in the text.
  const digits = asciiDigits(text).replace(/\u066B/g, '.');
  let phrases: string | null = null;

  const contains = (value: string): boolean => {
    const core = FIGURE_CORE.exec(asciiDigits(value).replace(/\u066B/g, '.'))?.[0];
    if (!core) return false;
    const margin = 2 * value.length + 40;
    for (let at = digits.indexOf(core); at !== -1; at = digits.indexOf(core, at + 1)) {
      if (appearsInDocuments(value, [text.slice(Math.max(0, at - margin), at + core.length + margin)])) return true;
    }
    return false;
  };

  const hasFigure = (figure: string): boolean => figureForms(figure).some(contains);

  /**
   * A target is found when it is written as given, or else when every figure in it is ("1,200 households"
   * when the document has "1,200" under a "households" heading). A target without figures must be
   * written as given.
   */
  const hasTarget = (target: string): boolean => {
    if (!target.trim()) return false;
    if (contains(target)) return true;
    const figures = Array.from(target.matchAll(FIGURE), m => m[0]);
    if (figures.length > 0) return figures.every(hasFigure);
    phrases ??= normalisePhrase(text);
    const phrase = normalisePhrase(target);
    return phrase.length >= 2 && phrases.includes(phrase);
  };

  return { hasFigure, hasTarget };
}

/**
 * Checks the (normalised) answer against the document's redacted text: each target mentioned gets
 * `verified` (found in the text by string match), and `unverifiedFigures` lists the numbers in the
 * summary and key findings that the text does not contain (deduplicated, at most 20; years and
 * single-digit counts are not checked). Nothing is dropped; the app marks what is not verified.
 */
export function verifyDocumentAnalysis(answer: DocumentAnalysisAnswer, redactedText: string): VerifiedDocumentAnalysis {
  const matcher = documentMatcher(redactedText);
  const unverified = new Set<string>();
  for (const value of [answer.summary, ...answer.keyFindings]) {
    for (const [figure] of value.matchAll(FIGURE)) {
      if (unverified.size >= MAX_UNVERIFIED_FIGURES) break;
      if (worthChecking(figure) && !unverified.has(figure) && !matcher.hasFigure(figure)) unverified.add(figure);
    }
  }
  return {
    ...answer,
    targetsMentioned: answer.targetsMentioned.map(t => ({ ...t, verified: matcher.hasTarget(t.target) })),
    unverifiedFigures: [...unverified],
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

/** A text item of a PDF page, as pdf.js (used by pdf-parse) returns it. */
export interface PdfTextItem {
  str: string;
  /** Text matrix [a, b, c, d, x, y]: x and y are where the text starts on the page. */
  transform: number[];
  /** Width of the text on the page (same units as x). */
  width: number;
  /** Font size on the page. */
  height: number;
}

/**
 * Joins the text items of one PDF page. pdf-parse's own renderer adds nothing between items on the
 * same line, so the cells of a table row run together ("Ahmad Ali4012345670599123456Gaza") and no
 * phone or ID number in them can be recognised. Here a change of line gives a line break, and items
 * on the same line are separated by a space (a gap up to about a word space) or a tab (a wider gap,
 * such as between table cells), unless they touch or a space is already there. The gap is measured
 * in either direction, so right-to-left text is separated too.
 */
export function joinPdfTextItems(items: readonly PdfTextItem[]): string {
  let text = '';
  let last: { y: number; left: number; right: number; size: number } | null = null;
  for (const item of items) {
    const str = typeof item?.str === 'string' ? item.str : '';
    if (!str) continue;
    const matrix = Array.isArray(item.transform) ? item.transform : [];
    const x = Number(matrix[4]) || 0;
    const y = Number(matrix[5]) || 0;
    const size = Math.abs(Number(item.height)) || Math.hypot(Number(matrix[2]) || 0, Number(matrix[3]) || 0) || 10;
    const width = Math.max(0, Number(item.width) || 0);
    if (last) {
      if (Math.abs(y - last.y) > Math.min(size, last.size) / 2) {
        text += '\n';
      } else {
        const em = Math.max(size, last.size);
        const gap = x >= last.right ? x - last.right : x + width <= last.left ? last.left - (x + width) : 0;
        if (gap > em * 0.1 && !/\s$/.test(text) && !/^\s/.test(str)) text += gap < em * 0.4 ? ' ' : '\t';
      }
    }
    text += str;
    last = { y, left: x, right: x + width, size };
  }
  return text;
}

interface PdfPage {
  getTextContent(options: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }): Promise<{ items: PdfTextItem[] }>;
}

async function renderPdfPage(page: PdfPage): Promise<string> {
  const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
  return joinPdfTextItems(content.items);
}

/** The text of a PDF, with table cells and lines kept apart (see joinPdfTextItems). */
export async function parsePdf(buffer: Buffer): Promise<string> {
  const pdfParse = (await import('pdf-parse')).default;
  // A plain Uint8Array copy, not a Buffer: pdf.js copies a Buffer input with `new Buffer(…)`, which puts
  // a small file (under 4 KB) in Node's shared buffer pool, and then reads the pool's whole memory —
  // another, earlier file in the pool is parsed instead, or parsing fails.
  const data = await pdfParse(new Uint8Array(buffer) as unknown as Buffer, { pagerender: renderPdfPage });
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
