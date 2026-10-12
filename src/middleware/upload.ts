import multer from 'multer';
import path from 'path';
import { AppError } from './errorHandler';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

type Signature = 'pdf' | 'zip';

// Extension → accepted MIME types and expected file signature (magic bytes). Word 97–2003 (.doc)
// files are refused: the parser cannot read them (it reads .docx only).
const ALLOWED: Record<string, { mimes: string[]; signature: Signature }> = {
  '.pdf': { mimes: ['application/pdf'], signature: 'pdf' },
  '.docx': { mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], signature: 'zip' },
  '.xlsx': { mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], signature: 'zip' },
};

export const UNSUPPORTED_TYPE_MESSAGE = 'Unsupported file type. Upload a PDF, Word (.docx) or Excel (.xlsx) file.';
export const OLD_WORD_MESSAGE = 'Word 97–2003 (.doc) files cannot be read. Save it as .docx or a text-based PDF and upload it again.';

// Some browsers and operating systems send a generic type for Office files;
// the file signature check below still applies.
const GENERIC_MIMES = ['application/octet-stream', 'application/zip', 'application/x-zip-compressed'];

const SIGNATURES: Record<Signature, number[]> = {
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  zip: [0x50, 0x4b, 0x03, 0x04], // PK..
};

export function isAllowedUpload(originalName: string, mimetype: string): boolean {
  const rule = ALLOWED[path.extname(originalName).toLowerCase()];
  return !!rule && (rule.mimes.includes(mimetype) || GENERIC_MIMES.includes(mimetype));
}

export function hasExpectedSignature(originalName: string, buffer: Buffer): boolean {
  const rule = ALLOWED[path.extname(originalName).toLowerCase()];
  if (!rule) return false;
  const expected = SIGNATURES[rule.signature];
  return buffer.length >= expected.length && expected.every((byte, i) => buffer[i] === byte);
}

/** Multer instance for project documents: in memory, size-capped, PDF, Word (.docx) and Excel (.xlsx) only. */
export const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedUpload(file.originalname, file.mimetype)) cb(null, true);
    else if (path.extname(file.originalname).toLowerCase() === '.doc') cb(new AppError(400, OLD_WORD_MESSAGE));
    else cb(new AppError(400, UNSUPPORTED_TYPE_MESSAGE));
  },
});

/** Throws if the uploaded file's content does not match its extension. */
export function assertFileContent(file: Express.Multer.File): void {
  if (!hasExpectedSignature(file.originalname, file.buffer)) {
    throw new AppError(400, 'The file content does not match its type. Upload a valid PDF, Word (.docx) or Excel (.xlsx) file.');
  }
}
