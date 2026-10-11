/**
 * Moves documents that were stored in the old public `uploads/` folder into
 * private storage (Supabase Storage when configured) and updates their records.
 *
 *   npm run storage:migrate            # dry run: lists what would move
 *   npm run storage:migrate -- --apply # copies files and updates records
 *
 * Original files are left in place; delete `uploads/` yourself once you have
 * checked that downloads work.
 */
import fs from 'fs';
import path from 'path';
import { prisma } from '../src/config/prisma';
import { buildDocumentKey, getStorage } from '../src/services/storage';

const apply = process.argv.includes('--apply');

function contentType(fileName: string): string {
  const types: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
  };
  return types[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

async function main() {
  const storage = getStorage();
  if (storage.name !== 'supabase') {
    console.log('Supabase Storage is not configured; local development already reads legacy uploads in place. Nothing to migrate.');
    return;
  }

  const legacy = await prisma.document.findMany({
    where: { fileUrl: { startsWith: '/uploads/' } },
    select: { id: true, projectId: true, fileName: true, fileUrl: true },
  });
  console.log(`${legacy.length} document(s) still point at the public uploads folder.${apply ? '' : ' (dry run)'}`);

  let moved = 0;
  let missing = 0;
  for (const doc of legacy) {
    const localPath = path.join(process.cwd(), doc.fileUrl);
    if (!fs.existsSync(localPath)) {
      console.warn(`  - ${doc.id} ${doc.fileName}: file not found at ${doc.fileUrl}`);
      missing++;
      continue;
    }
    const key = buildDocumentKey(doc.projectId, doc.fileName);
    console.log(`  - ${doc.id} ${doc.fileName}: ${doc.fileUrl} → ${key}`);
    if (!apply) continue;

    await storage.put(key, await fs.promises.readFile(localPath), contentType(doc.fileName));
    await prisma.document.update({ where: { id: doc.id }, data: { fileUrl: key } });
    moved++;
  }

  console.log(apply
    ? `Moved ${moved} file(s); ${missing} missing.`
    : `Dry run complete; ${missing} missing. Re-run with --apply to move the files.`);
}

main()
  .catch(err => {
    console.error('Migration failed:', err.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
