import { FrameworkStatus, Prisma, ProjectStatus } from '@prisma/client';
import type { AuditTarget } from '../../middleware/audit';
import { safeErrorSummary } from '../ai/errors';
import { getStorage } from '../storage';

/**
 * Archive, restore and permanent delete of a project (owner decision of 13 October 2026).
 *
 * - Archive: any project; hidden from the project list, nothing lost, read-only (the access helpers answer 409
 *   `project_archived` to writes), can be restored. M&E practice: archive real projects, which donors may audit
 *   for years.
 * - Restore: back to the status the project had when it was archived (from the archive's audit row), or one
 *   derived from its frameworks.
 * - Delete forever: org admins and platform admins, after typing the project name; for test or mistaken
 *   projects. Every row of the project goes in one transaction; the stored files after it commits.
 *
 * The decisions (name check, restored status) are pure functions, unit tested in tests/projectArchive.test.ts.
 */

export const ALREADY_ARCHIVED = { message: 'This project is already archived.', code: 'project_already_archived' } as const;
export const NOT_ARCHIVED = { message: 'This project is not archived.', code: 'project_not_archived' } as const;
export const CONFIRM_NAME_MISMATCH = {
  message: 'Type the project name exactly as it is shown to delete the project.',
  code: 'confirm_name_mismatch',
} as const;

/** A permanent delete refused by a foreign key: a row outside the project refers to it, and nothing was deleted. */
export const DELETE_BLOCKED_MESSAGE = 'This project could not be deleted: records outside it still refer to it. Nothing was deleted.';

/** Interactive transaction limits for a permanent delete (a large project has many rows). */
export const DELETE_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

/** Stored files are removed a few at a time after the delete commits. */
const STORAGE_REMOVAL_CONCURRENCY = 5;

/**
 * The typed confirmation matches: `confirmName` is text and, without leading and trailing spaces, is exactly
 * the project's name without them (same capitals, nothing added). Anything else, an empty text included, is false.
 */
export function confirmNameMatches(confirmName: unknown, projectName: string): boolean {
  if (typeof confirmName !== 'string') return false;
  const typed = confirmName.trim();
  return typed.length > 0 && typed === projectName.trim();
}

const PROJECT_STATUSES: ReadonlySet<string> = new Set(Object.values(ProjectStatus));

/** The status an archive audit row recorded as the one before archiving (`previousValue.status`), or null. */
export function statusBeforeArchive(previousValue: Prisma.JsonValue | null | undefined): ProjectStatus | null {
  if (!previousValue || typeof previousValue !== 'object' || Array.isArray(previousValue)) return null;
  const status = (previousValue as Prisma.JsonObject).status;
  if (typeof status !== 'string' || status === 'archived' || !PROJECT_STATUSES.has(status)) return null;
  return status as ProjectStatus;
}

/** A framework the project approved: approved, or in use after approval. */
const APPROVED_FRAMEWORK_STATUSES: ReadonlySet<FrameworkStatus> = new Set<FrameworkStatus>(['approved', 'active']);

/**
 * The status of a restored project when no archive audit row records the one before (a project archived by
 * the old DELETE, or by a status edit before 13 October 2026): `active` with an approved framework,
 * `framework_review` with any framework, else `setup`. Pass the project's frameworks whose generation did not
 * fail (generationError empty): a failed AI version never moved a project on.
 */
export function derivedRestoreStatus(frameworks: readonly { status: FrameworkStatus }[]): ProjectStatus {
  if (frameworks.some(fw => APPROVED_FRAMEWORK_STATUSES.has(fw.status))) return 'active';
  if (frameworks.length > 0) return 'framework_review';
  return 'setup';
}

/** The audit action of an archive (POST /api/projects/:id/archive), which restore looks up. */
export function archiveAuditAction(projectId: string): string {
  return `POST /api/projects/${projectId}/archive`;
}

/**
 * The audit row of an archive, restore or permanent delete (writeRequestAudit): the route as registered with the
 * project's id, entity `projects` and the project's id, built from the locked row rather than the request path,
 * whose capitals the caller chooses (Express routes `POST /API/Projects/<id>/Archive` here too), so restore finds
 * the archive's row and a review by entity finds every one of them.
 */
export function projectAuditTarget(change: 'archive' | 'restore' | 'delete', projectId: string): AuditTarget {
  const action = change === 'archive' ? archiveAuditAction(projectId)
    : change === 'restore' ? `POST /api/projects/${projectId}/restore`
      : `DELETE /api/projects/${projectId}`;
  return { action, entity: 'projects', entityId: projectId };
}

export interface LockedProject {
  id: string;
  name: string;
  status: ProjectStatus;
  organizationId: string;
}

/**
 * Locks the project row until the transaction ends (SELECT … FOR UPDATE), so a concurrent archive, restore,
 * delete, edit (PATCH /api/projects/:id) or framework approval waits and then sees the committed status, and no
 * row can be added to the project meanwhile (inserting a child row takes a key-share lock on the project). Null
 * when the project no longer exists.
 */
export async function lockProject(tx: Prisma.TransactionClient, projectId: string): Promise<LockedProject | null> {
  const rows = await tx.$queryRaw<LockedProject[]>`
    SELECT "id", "name", "status"::text AS "status", "organizationId"
    FROM "Project"
    WHERE "id" = ${projectId}
    FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * The status to restore: the one recorded by the project's latest archive audit row, else the derived one.
 * `source` says which, for the restore's own audit row.
 */
export async function restoreStatus(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<{ status: ProjectStatus; source: 'archive_audit' | 'derived' }> {
  const latest = await tx.auditLog.findFirst({
    where: { entity: 'projects', entityId: projectId, action: archiveAuditAction(projectId), previousValue: { not: Prisma.DbNull } },
    orderBy: { timestamp: 'desc' },
    select: { previousValue: true },
  });
  const recorded = statusBeforeArchive(latest?.previousValue);
  if (recorded) return { status: recorded, source: 'archive_audit' };
  const frameworks = await tx.framework.findMany({ where: { projectId, generationError: null }, select: { status: true } });
  return { status: derivedRestoreStatus(frameworks), source: 'derived' };
}

/** Rows a permanent delete removed, per table (the response and the audit row). */
export interface RemovedRows {
  frameworks: number;
  resultNodes: number;
  indicators: number;
  assessments: number;
  dataPoints: number;
  qualitativeEntries: number;
  beneficiaries: number;
  beneficiaryServices: number;
  reports: number;
  documents: number;
  notifications: number;
}

/** A deleted document's file in private storage. */
export interface StoredFile {
  documentId: string;
  key: string;
}

/**
 * Deletes every row of the project, in dependency order, inside the caller's transaction (which must hold
 * lockProject): beneficiary services, data points, qualitative entries, assessments, beneficiaries, reports,
 * documents, the indicators and results chains of its frameworks (parent links cleared first: the parent
 * foreign key is ON DELETE RESTRICT), the frameworks, the organisation's notifications whose link holds the
 * project id, then the project. AiCall rows keep their cost history: their projectId is emptied by the
 * foreign key (ON DELETE SET NULL). Audit rows are kept. Returns the counts and the stored files of the
 * deleted documents, to remove once the transaction has committed (removeStoredFiles).
 */
export async function deleteProjectRows(
  tx: Prisma.TransactionClient,
  project: Pick<LockedProject, 'id' | 'organizationId'>,
): Promise<{ removed: RemovedRows; storedFiles: StoredFile[] }> {
  const projectId = project.id;
  // Locked too, so no indicator or result can be added to them while they are deleted.
  const frameworkIds = (await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Framework" WHERE "projectId" = ${projectId} FOR UPDATE`).map(row => row.id);
  const documents = await tx.document.findMany({ where: { projectId }, select: { id: true, fileUrl: true } });

  const beneficiaryServices = (await tx.beneficiaryService.deleteMany({ where: { projectId } })).count;
  const dataPoints = (await tx.dataPoint.deleteMany({ where: { projectId } })).count;
  const qualitativeEntries = (await tx.qualitativeEntry.deleteMany({ where: { projectId } })).count;
  const assessments = (await tx.assessment.deleteMany({ where: { projectId } })).count;
  const beneficiaries = (await tx.beneficiary.deleteMany({ where: { projectId } })).count;
  const reports = (await tx.report.deleteMany({ where: { projectId } })).count;
  const documentRows = (await tx.document.deleteMany({ where: { projectId } })).count;
  const indicators = (await tx.indicator.deleteMany({ where: { frameworkId: { in: frameworkIds } } })).count;
  await tx.resultNode.updateMany({ where: { frameworkId: { in: frameworkIds }, parentId: { not: null } }, data: { parentId: null } });
  const resultNodes = (await tx.resultNode.deleteMany({ where: { frameworkId: { in: frameworkIds } } })).count;
  const frameworks = (await tx.framework.deleteMany({ where: { projectId } })).count;
  const notifications = (await tx.notification.deleteMany({
    where: { link: { contains: projectId }, user: { organizationId: project.organizationId } },
  })).count;
  await tx.project.delete({ where: { id: projectId } });

  return {
    removed: {
      frameworks, resultNodes, indicators, assessments, dataPoints, qualitativeEntries, beneficiaries, beneficiaryServices,
      reports, documents: documentRows, notifications,
    },
    storedFiles: documents.map(doc => ({ documentId: doc.id, key: doc.fileUrl })),
  };
}

/**
 * Removes the stored files of deleted documents, best effort, after the delete committed. A file that cannot
 * be removed is logged with its document id and the error class only (never the file name, the storage key or
 * the error message, which can quote a path) and counted as failed; it never fails the request.
 */
export async function removeStoredFiles(files: readonly StoredFile[]): Promise<{ removed: number; failed: number }> {
  const storage = getStorage();
  let removed = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      try {
        await storage.remove(file.key);
        removed++;
      } catch (err) {
        failed++;
        console.error(`[Projects] Could not remove the stored file of deleted document ${file.documentId} (${safeErrorSummary(err)})`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STORAGE_REMOVAL_CONCURRENCY, files.length) }, worker));
  return { removed, failed };
}
