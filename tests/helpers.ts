import { UserRole } from '@prisma/client';
import { prisma } from '../src/config/prisma';
import { generateAccessToken } from '../src/utils/tokens';
import { buildDocumentKey, getStorage } from '../src/services/storage';

export const hasTestDatabase = !!process.env.TEST_DATABASE_URL;

if (hasTestDatabase) {
  const dbName = new URL(process.env.TEST_DATABASE_URL!).pathname;
  if (!/test/i.test(dbName)) {
    throw new Error(`TEST_DATABASE_URL must point at a disposable database whose name contains "test" (got ${dbName}). Tests delete all data.`);
  }
} else {
  console.warn('[tests] TEST_DATABASE_URL is not set; integration tests are skipped.');
}

/** Deletes every row in the test database. */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'`;
  if (tables.length === 0) return;
  const list = tables.map(t => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}

export function bearer(user: { id: string; email: string; organizationId: string; role: UserRole; fullName: string }) {
  return `Bearer ${generateAccessToken({
    id: user.id,
    email: user.email,
    organizationId: user.organizationId,
    role: user.role,
    fullName: user.fullName,
  })}`;
}

export const PDF_BYTES = Buffer.from('%PDF-1.4\n% test document\n%%EOF\n');

/** Creates an organisation with one of every project-owned resource. */
export async function createOrgFixture(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Org ${label}`, type: 'local_ngo', country: 'Palestine', city: 'Ramallah', contactEmail: `${label}@example.org` },
  });
  const admin = await prisma.user.create({
    data: { organizationId: org.id, email: `admin-${label}@example.org`, passwordHash: 'x', fullName: `Admin ${label}`, role: 'org_admin' },
  });
  const officer = await prisma.user.create({
    data: { organizationId: org.id, email: `me-${label}@example.org`, passwordHash: 'x', fullName: `Officer ${label}`, role: 'me_officer' },
  });
  const project = await prisma.project.create({
    data: {
      organizationId: org.id, name: `Project ${label}`, sector: 'education', donor: 'EU', donorType: 'eu',
      startDate: new Date('2026-01-01'), endDate: new Date('2027-12-31'),
    },
  });
  const framework = await prisma.framework.create({ data: { projectId: project.id, version: 1 } });
  const indicator = await prisma.indicator.create({
    data: {
      frameworkId: framework.id, indicatorText: `Indicator ${label}`, level: 'outcome',
      dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: ['baseline', 'endline'],
    },
  });
  const assessment = await prisma.assessment.create({ data: { projectId: project.id, type: 'baseline', methodsIncluded: ['hh_survey'] } });
  const dataPoint = await prisma.dataPoint.create({
    data: {
      indicatorId: indicator.id, projectId: project.id, value: '10', collectionDate: new Date('2026-03-01'),
      collectionMethod: 'hh_survey', createdBy: officer.id,
    },
  });
  const qualitative = await prisma.qualitativeEntry.create({
    data: { projectId: project.id, entryType: 'field_notes', title: `Notes ${label}`, content: 'Field notes' },
  });
  const report = await prisma.report.create({ data: { projectId: project.id, type: 'quarterly_summary', title: `Report ${label}` } });
  const beneficiary = await prisma.beneficiary.create({ data: { projectId: project.id, fullName: `Person ${label}`, gender: 'female' } });

  const documentKey = buildDocumentKey(project.id, 'proposal.pdf');
  await getStorage().put(documentKey, PDF_BYTES, 'application/pdf');
  const document = await prisma.document.create({
    data: {
      projectId: project.id, uploadedBy: officer.id, fileName: 'proposal.pdf', fileUrl: documentKey,
      fileType: 'proposal', fileSizeBytes: PDF_BYTES.length,
    },
  });

  return {
    org, admin, officer, project, framework, indicator, assessment, dataPoint, qualitative, report, beneficiary, document,
    adminAuth: bearer(admin),
    officerAuth: bearer(officer),
  };
}

export type OrgFixture = Awaited<ReturnType<typeof createOrgFixture>>;
