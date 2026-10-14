/**
 * Reject a KPI suggestion with a reason (and an optional, redacted note) so later runs learn from it
 * (knowledge/kpi-assistant-spec.md §A1, §A5; design sections 8.2–8.3, D8, D9). The note is never sent to a model:
 * preferences read the reason only (context.ts never loads rejectNote).
 */
import { SuggestionRejectReason } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { assertProjectWritableLocked } from '../../middleware/access';
import { AppError } from '../../middleware/errorHandler';
import { redactPersonalData } from '../ai/redact';
import { KPI_TRANSACTION_OPTIONS, lockProject, toSuggestionDto } from './runs';
import type { KpiSuggestionDto } from './types';

/** Longest reject note (characters, after trimming). */
export const MAX_REJECT_NOTE_CHARS = 1000;

const rejectSchema = z.object({
  reason: z.nativeEnum(SuggestionRejectReason, {
    errorMap: () => ({ message: `reason must be one of: ${Object.values(SuggestionRejectReason).join(', ')}` }),
  }),
  note: z.string({ invalid_type_error: 'note must be text' })
    .trim()
    .max(MAX_REJECT_NOTE_CHARS, `note must be at most ${MAX_REJECT_NOTE_CHARS} characters`)
    .nullish(),
}, { invalid_type_error: 'the request body must be a JSON object', required_error: 'the request body must be a JSON object' });

/**
 * `{ reason: SuggestionRejectReason, note?: string }` (design 7.3, 8.2): note trimmed, at most 1000 characters, empty →
 * null, saved as redactPersonalData(note).text (CLAUDE.md rule 5: the audit log stores the response, which then holds
 * only redacted text). Throws AppError 400 naming the problem.
 */
export function parseRejectBody(body: unknown): { reason: SuggestionRejectReason; note: string | null } {
  const parsed = rejectSchema.safeParse(body ?? undefined);
  if (!parsed.success) throw new AppError(400, `Invalid request: ${parsed.error.issues.map(i => i.message).join('; ')}`);
  const note = parsed.data.note ? redactPersonalData(parsed.data.note).text : null;
  return { reason: parsed.data.reason, note: note && note.trim() ? note : null };
}

/**
 * Records the rejection (design 8.2): organisation-scoped load (404), then, under the project's KPI lock (lockProject) and
 * with the archived rule checked again on the share-locked project row (409 project_archived), one conditional update from pending → rejected with decidedAt, decidedBy, rejectReason and the redacted rejectNote; nothing changed (no longer pending) →
 * 409 already_decided. The rejection then excludes the library id per REJECTION_SCOPE (preferences.ts, D9).
 */
export async function rejectKpiSuggestion(input: { suggestionId: string; organizationId: string; userId: string; body: unknown }): Promise<{ suggestion: KpiSuggestionDto }> {
  const existing = await prisma.kpiSuggestion.findFirst({
    where: { id: input.suggestionId, project: { organizationId: input.organizationId } },
    select: { id: true, projectId: true },
  });
  if (!existing) throw new AppError(404, 'Suggestion not found');
  const { reason, note } = parseRejectBody(input.body);

  // Under the project's KPI lock (CC-04, CC-05): a run saving its cards at the same time sees this rejection.
  const count = await prisma.$transaction(async tx => {
    await lockProject(tx, existing.projectId);
    // An archive that committed after the route's access check: 409 project_archived, the suggestion stays pending.
    await assertProjectWritableLocked(tx, existing.projectId);
    return (await tx.kpiSuggestion.updateMany({
      where: { id: existing.id, status: 'pending' },
      data: { status: 'rejected', decidedAt: new Date(), decidedBy: input.userId, rejectReason: reason, rejectNote: note },
    })).count;
  }, KPI_TRANSACTION_OPTIONS);
  if (count !== 1) throw new AppError(409, 'This suggestion was already accepted, rejected or expired.', 'already_decided');
  const row = await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: existing.id } });
  console.log(`[KpiReject] ${row.id} rejected (${reason})`);
  return { suggestion: toSuggestionDto(row) };
}
