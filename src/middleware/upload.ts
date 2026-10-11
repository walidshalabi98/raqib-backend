import multer from 'multer';
import path from 'path';
import { AppError } from './errorHandler';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

type Signature = 'pdf' | 'zip' | 'ole';

// Extension → accepted MIME types and expected file signature (magic bytes).
const ALLOWED: Record<string, { mimes: string[]; signature: Signature }> = {
  '.pdf': { mimes: ['application/pdf'], signature: 'pdf' },
  '.docx': { mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], signature: 'zip' },
  '.xlsx': { mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], signature: 'zip' },
  '.doc': { mimes: ['application/msword'], signature: 'ole' },
};

// Some browsers and operating systems send a generic type for Office files;
// the file signature check below still applies.
const GENERIC_MIMES = ['application/octet-stream', 'application/zip', 'application/x-zip-compressed'];

const SIGNATURES: Record<Signature, number[]> = {
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  zip: [0x50, 0x4b, 0x03, 0x04], // PK..
  ole: [0xd0, 0xcf, 0x11, 0xe0], // OLE compound file
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

/** Multer instance for project documents: in memory, size-capped, PDF/Word/Excel only. */
export const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedUpload(file.originalname, file.mimetype)) cb(null, true);
    else cb(new AppError(400, 'Unsupported file type. Upload a PDF, Word (.docx, .doc) or Excel (.xlsx) file.'));
  },
});

/** Throws if the uploaded file's content does not match its extension. */
export function assertFileContent(file: Express.Multer.File): void {
  if (!hasExpectedSignature(file.originalname, file.buffer)) {
    throw new AppError(400, 'The file content does not match its type. Upload a valid PDF, Word or Excel file.');
  }
}
