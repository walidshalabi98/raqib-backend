import { Router, Request, Response } from 'express';
import path from 'path';
import { getLocalStorage } from '../services/storage';

const router = Router();

// GET /api/files/local — Serves a file from local development storage.
// Only reachable through a short-lived signed URL issued after an access check
// (see GET /api/documents/:id/download). Not available when Supabase Storage is used.
router.get('/local', (req: Request, res: Response) => {
  const storage = getLocalStorage();
  if (!storage) {
    res.status(404).json({ message: 'Not found' });
    return;
  }

  const key = String(req.query.key || '');
  const name = String(req.query.name || '');
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig || '');

  const filePath = key && sig ? storage.verify(key, name, exp, sig) : null;
  if (!filePath) {
    res.status(403).json({ message: 'This download link is invalid or has expired.' });
    return;
  }

  res.download(filePath, path.basename(name) || 'download', err => {
    if (err && !res.headersSent) res.status(404).json({ message: 'File not found' });
  });
});

export default router;
