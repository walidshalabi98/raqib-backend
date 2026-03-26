import fs from 'fs';
import path from 'path';
import { prisma } from '../../config/prisma';

export async function parseDocument(documentId: string): Promise<void> {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc) throw new Error(`Document ${documentId} not found`);

  await prisma.document.update({
    where: { id: documentId },
    data: { parsingStatus: 'processing' },
  });

  try {
    const filePath = path.join(process.cwd(), doc.fileUrl);
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const ext = path.extname(doc.fileName).toLowerCase();
    let text = '';

    if (ext === '.pdf') {
      text = await parsePdf(filePath);
    } else if (ext === '.docx' || ext === '.doc') {
      text = await parseDocx(filePath);
    } else if (ext === '.xlsx' || ext === '.xls') {
      text = await parseExcel(filePath);
    } else {
      throw new Error(`Unsupported file type: ${ext}`);
    }

    // If PDF parsing returned very little text, try OCR
    if (ext === '.pdf' && text.trim().length < 100) {
      console.log(`[DocumentParser] Low text content, attempting OCR for ${doc.fileName}`);
      text = await ocrPdf(filePath);
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

async function parsePdf(filePath: string): Promise<string> {
  const pdfParse = (await import('pdf-parse')).default;
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

async function parseDocx(filePath: string): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

async function parseExcel(filePath: string): Promise<string> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.readFile(filePath);
  const texts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    texts.push(`--- Sheet: ${sheetName} ---\n${csv}`);
  }

  return texts.join('\n\n');
}

async function ocrPdf(filePath: string): Promise<string> {
  try {
    const Tesseract = await import('tesseract.js');
    // For OCR, we'd typically convert PDF pages to images first.
    // Simplified: attempt Tesseract on the file directly (works for image-based PDFs)
    const { data } = await Tesseract.recognize(filePath, 'eng+ara');
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
