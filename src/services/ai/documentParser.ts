import path from 'path';
import { prisma } from '../../config/prisma';
import { getStorage } from '../storage';

export async function parseDocument(documentId: string): Promise<void> {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc) throw new Error(`Document ${documentId} not found`);

  await prisma.document.update({
    where: { id: documentId },
    data: { parsingStatus: 'processing' },
  });

  try {
    const buffer = await getStorage().get(doc.fileUrl);

    const ext = path.extname(doc.fileName).toLowerCase();
    let text = '';

    if (ext === '.pdf') {
      text = await parsePdf(buffer);
    } else if (ext === '.docx' || ext === '.doc') {
      text = await parseDocx(buffer);
    } else if (ext === '.xlsx') {
      text = await parseExcel(buffer);
    } else {
      throw new Error(`Unsupported file type: ${ext}`);
    }

    // If PDF parsing returned very little text, try OCR
    if (ext === '.pdf' && text.trim().length < 100) {
      console.log(`[DocumentParser] Low text content, attempting OCR for ${doc.fileName}`);
      text = await ocrPdf(buffer);
    }

    await prisma.document.update({
      where: { id: documentId },
      data: {
        parsedText: text,
        parsingStatus: 'completed',
      },
    });

    // AI analysis of document content
    if (text && text.length > 50) {
      try {
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

        const analysisResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{
            role: 'user',
            content: `Analyze this project document and extract key M&E-relevant information. Return a JSON object with:
{
  "documentType": "proposal|logframe|budget|report|guidelines|other",
  "keyFindings": ["finding1", "finding2"],
  "indicators_mentioned": ["indicator1", "indicator2"],
  "targets_mentioned": [{"indicator": "...", "target": "...", "timeline": "..."}],
  "recommendations": ["rec1", "rec2"],
  "summary": "2-3 sentence summary"
}

Document text (first 3000 chars):
${text.substring(0, 3000)}

Return ONLY valid JSON, no markdown.`
          }],
        });

        const aiText = analysisResponse.content[0].type === 'text' ? analysisResponse.content[0].text : '';
        const cleaned = aiText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        await prisma.document.update({
          where: { id: documentId },
          data: { parsedText: text + '\n\n---AI_ANALYSIS---\n' + cleaned },
        });
        console.log(`[DocumentParser] AI analysis complete for ${doc.fileName}`);
      } catch (aiErr: any) {
        console.error('[DocumentParser] AI analysis failed:', aiErr.message);
      }
    }

    console.log(`[DocumentParser] Successfully parsed ${doc.fileName} (${text.length} chars)`);
  } catch (error) {
    console.error(`[DocumentParser] Failed to parse ${doc.fileName}:`, error);
    await prisma.document.update({
      where: { id: documentId },
      data: { parsingStatus: 'failed' },
    });
    throw error;
  }
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
    console.warn('[DocumentParser] OCR failed, returning empty text:', error);
    return '';
  }
}

/**
 * Chunk text into segments for embedding/LLM processing
 */
export function chunkText(text: string, chunkSize = 2000, overlap = 200): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start = end - overlap;
    if (start >= text.length) break;
  }

  return chunks;
}
