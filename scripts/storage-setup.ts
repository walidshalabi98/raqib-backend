/**
 * Creates the private Supabase Storage bucket for documents, or checks that
 * the existing bucket is private. Safe to run more than once.
 *
 *   npm run storage:setup
 */
import { createClient } from '@supabase/supabase-js';
import { env } from '../src/config/env';
import { MAX_UPLOAD_BYTES } from '../src/middleware/upload';

async function main() {
  if (!env.supabaseUrl || !env.supabaseServiceKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.');
    process.exit(1);
  }
  const supabase = createClient(env.supabaseUrl, env.supabaseServiceKey, { auth: { persistSession: false } });
  const bucket = env.storageBucket;

  const { data: existing, error: getError } = await supabase.storage.getBucket(bucket);
  if (existing) {
    if (existing.public) {
      console.error(`Bucket "${bucket}" exists but is PUBLIC. Make it private in the Supabase dashboard (Storage → ${bucket} → Edit bucket).`);
      process.exit(1);
    }
    console.log(`Bucket "${bucket}" exists and is private. Nothing to do.`);
    return;
  }
  if (getError && !/not found/i.test(getError.message)) throw getError;

  const { error } = await supabase.storage.createBucket(bucket, {
    public: false,
    fileSizeLimit: MAX_UPLOAD_BYTES,
  });
  if (error) throw error;
  console.log(`Created private bucket "${bucket}".`);
}

main().catch(err => {
  console.error('Storage setup failed:', err.message || err);
  process.exit(1);
});
