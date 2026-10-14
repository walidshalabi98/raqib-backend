import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env';

/**
 * Private file storage. Files are never served publicly: callers check
 * organisation access first, then hand out a short-lived signed URL.
 *
 * - Supabase Storage (private bucket) when SUPABASE_URL and SUPABASE_SERVICE_KEY are set.
 * - Local disk outside any static route otherwise (development and tests only).
 */
export interface StorageProvider {
  readonly name: 'supabase' | 'local';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  signedUrl(key: string, expiresInSeconds: number, downloadName: string): Promise<string>;
}

export const SIGNED_URL_TTL_SECONDS = 5 * 60;

class SupabaseStorage implements StorageProvider {
  readonly name = 'supabase' as const;
  private client: SupabaseClient;

  constructor(url: string, serviceKey: string, private bucket: string) {
    this.client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).upload(key, body, { contentType, upsert: false });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }

  async get(key: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(this.bucket).download(key);
    if (error || !data) throw new Error(`Storage download failed: ${error?.message || 'no data'}`);
    return Buffer.from(await data.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).remove([key]);
    if (error) throw new Error(`Storage delete failed: ${error.message}`);
  }

  async signedUrl(key: string, expiresInSeconds: number, downloadName: string): Promise<string> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(key, expiresInSeconds, { download: downloadName });
    if (error || !data) throw new Error(`Could not sign URL: ${error?.message || 'no data'}`);
    return data.signedUrl;
  }
}

const LEGACY_PREFIX = '/uploads/';

class LocalStorage implements StorageProvider {
  readonly name = 'local' as const;
  private root: string;
  private legacyRoot: string;

  constructor(root: string, private apiUrl: string, private signingKey: Buffer) {
    this.root = path.resolve(root);
    this.legacyRoot = path.resolve(process.cwd(), 'uploads');
  }

  /** Resolves a key to a path inside the storage root; rejects traversal attempts. */
  resolve(key: string): string {
    const [base, relative] = key.startsWith(LEGACY_PREFIX)
      ? [this.legacyRoot, key.slice(LEGACY_PREFIX.length)]
      : [this.root, key];
    const full = path.resolve(base, relative);
    if (!full.startsWith(base + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, body, { flag: 'wx' });
  }

  async get(key: string): Promise<Buffer> {
    return fs.promises.readFile(this.resolve(key));
  }

  async remove(key: string): Promise<void> {
    await fs.promises.rm(this.resolve(key), { force: true });
  }

  async signedUrl(key: string, expiresInSeconds: number, downloadName: string): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const params = new URLSearchParams({ key, name: downloadName, exp: String(exp) });
    params.set('sig', this.sign(key, downloadName, exp));
    return `${this.apiUrl}/api/files/local?${params.toString()}`;
  }

  sign(key: string, name: string, exp: number): string {
    return crypto.createHmac('sha256', this.signingKey).update(`${key}\n${name}\n${exp}`).digest('hex');
  }

  /** Verifies a signed local URL. Returns the file path, or null if the signature is invalid or expired. */
  verify(key: string, name: string, exp: number, sig: string): string | null {
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
    const expected = Buffer.from(this.sign(key, name, exp), 'hex');
    const given = Buffer.from(sig, 'hex');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    try {
      return this.resolve(key);
    } catch {
      return null;
    }
  }
}

let instance: StorageProvider | undefined;

export function getStorage(): StorageProvider {
  if (!instance) {
    instance = env.supabaseUrl && env.supabaseServiceKey
      ? new SupabaseStorage(env.supabaseUrl, env.supabaseServiceKey, env.storageBucket)
      : new LocalStorage(
        env.localStorageDir,
        env.apiUrl,
        crypto.createHmac('sha256', env.jwtSecret).update('raqib-local-storage').digest(),
      );
  }
  return instance;
}

export function getLocalStorage(): LocalStorage | null {
  const storage = getStorage();
  return storage instanceof LocalStorage ? storage : null;
}

/**
 * Stores an uploaded file, then creates the database row that refers to it (`createRow`). When the row cannot be
 * created (for example the project was deleted forever while the file was being stored: the row's foreign key
 * then fails), the stored file is removed again, best effort, so no file stays in the private bucket without a
 * row pointing at it, where no route could ever find or remove it; the row's error is then thrown as before. A
 * removal that fails is logged with the project id and the error class only, never the file name, the storage
 * key or the error message (which can quote a path).
 */
export async function storeUploadedFile<T>(
  file: { key: string; body: Buffer; contentType: string; projectId: string },
  createRow: () => Promise<T>,
): Promise<T> {
  const storage = getStorage();
  await storage.put(file.key, file.body, file.contentType);
  try {
    return await createRow();
  } catch (err) {
    await storage.remove(file.key).catch((removeErr: unknown) => {
      const errorClass = removeErr instanceof Error ? removeErr.name || 'Error' : 'unknown error';
      console.error(`[Storage] Could not remove the stored file of an upload to project ${file.projectId} whose record was not saved (${errorClass})`);
    });
    throw err;
  }
}

export function buildDocumentKey(projectId: string, originalName: string): string {
  const ext = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, '');
  return `projects/${projectId}/${crypto.randomUUID()}${ext}`;
}
