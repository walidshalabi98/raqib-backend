/**
 * Accept (and edit & accept) a KPI suggestion: one transaction that creates the indicator through the normal
 * indicator validation and records the decision (knowledge/kpi-assistant-spec.md §A1, §A6; design section 8.1, D5).
 * The route has loaded the suggestion with assertKpiSuggestionAccess (CLAUDE.md rule 1); this module scopes every read
 * to the organisation again (defence in depth).
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { assertProjectWritableLocked } from '../../middleware/access';
import { AppError } from '../../middleware/errorHandler';
import { donorRulesFor } from '../ai/donorRules';
import { redactPersonalData } from '../ai/redact';
import { findCurrentFramework } from '../frameworks/current';
import { createIndicatorInFramework } from '../indicators/create';
import type { INDICATOR_INCLUDE } from '../indicators/selects';
import { DRAFT_EDITABLE_KEYS, draftToCreateInput, editedFields } from './draft';
import { normalisedIndicatorName } from './nameRules';
import { KPI_TRANSACTION_OPTIONS, lockProject, toSuggestionDto } from './runs';
import { warning } from './validate';
import type { IndicatorDraft, KpiSuggestionDto, KpiWarning } from './types';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Fields the server sets on accept (design 8.1): sent in edits they are ignored, never an error. */
const SERVER_SET_KEYS: ReadonlySet<string> = new Set(['provenance', 'aiModel', 'promptVersion', 'phases', 'sortOrder']);

/**
 * `{ edits?: object, replaceSource?: boolean }` (design 7.3: `{ "edits": { "indicatorText": "…", "targetValue": null } }`
 * or `{}`). A missing body or missing/null edits mean no edits; a body or edits value that is not a JSON object → 400.
 * `replaceSource: true` (SPEC-8; an alternative to an existing indicator only) removes that indicator in the same
 * transaction; anything but a boolean → 400. Unknown top-level keys are ignored. An edit key outside DRAFT_EDITABLE_KEYS
 * and the server-set fields (status, currentValue, actualStartDate, actualEndDate, milestones, any unknown key) → 400
 * not_editable with details.keys (TQ-02: such edits used to be dropped silently while the accept answered 201); the
 * server-set provenance, aiModel, promptVersion, phases and sortOrder stay ignored.
 */
export function parseAcceptBody(body: unknown): { edits: Record<string, unknown>; replaceSource: boolean } {
  if (body === undefined || body === null) return { edits: {}, replaceSource: false };
  if (!isObject(body)) throw new AppError(400, 'Invalid request: the request body must be a JSON object');
  const { edits, replaceSource } = body;
  if (replaceSource !== undefined && replaceSource !== null && typeof replaceSource !== 'boolean') {
    throw new AppError(400, 'Invalid request: replaceSource must be true or false');
  }
  const replace = replaceSource === true;
  if (edits === undefined || edits === null) return { edits: {}, replaceSource: replace };
  if (!isObject(edits)) throw new AppError(400, 'Invalid request: edits must be an object of indicator fields');
  // TQ-02: a field the draft does not hold (status, currentValue, actual dates, milestones, an unknown key) would be
  // dropped although the client meant to set it: refused. The server-set fields (provenance, aiModel, promptVersion,
  // phases, sortOrder; design 8.1) stay ignored, as before.
  const notEditable = Object.keys(edits)
    .filter(key => !(DRAFT_EDITABLE_KEYS as readonly string[]).includes(key) && !SERVER_SET_KEYS.has(key));
  if (notEditable.length > 0) {
    throw new AppError(400, `Invalid request: these fields cannot be changed when accepting a suggestion: ${notEditable.join(', ')}. `
      + 'Edit them on the indicator after accepting.', 'not_editable', { keys: notEditable });
  }
  return { edits, replaceSource: replace };
}

const SOURCE_HAS_DATA_MESSAGE = 'The indicator this alternative would replace already has data or linked services, so it cannot be removed. '
  + 'Accept the alternative without replacing it, then decide what to do with the old indicator.';

const STALE_MESSAGE = 'This suggestion is out of date: the framework or its result changed. Ask for new suggestions.';
const DECIDED_MESSAGE = 'This suggestion was already accepted or rejected.';

/** Thrown inside the transaction when the framework or the result changed since the first check (rolls back). */
class StaleSuggestion extends Error {
  constructor() {
    super('stale suggestion');
    this.name = 'StaleSuggestion';
  }
}

/** Marks a still-pending suggestion expired (stale accept, design 8.1 step 3). */
async function expireSuggestion(id: string): Promise<void> {
  await prisma.kpiSuggestion.updateMany({ where: { id, status: 'pending' }, data: { status: 'expired' } });
}

/** The draft stored in the payload (built by the server from the validated suggestion; design 4.2). */
function storedDraft(payload: Prisma.JsonValue): IndicatorDraft {
  const draft = isObject(payload) ? payload.draft : null;
  if (!isObject(draft)) throw new AppError(409, STALE_MESSAGE, 'stale');
  return draft as unknown as IndicatorDraft;
}

/**
 * Pending suggestions that an acceptance makes redundant (design 8.1, m13), excluding the accepted one:
 * - on the same result(s) (the suggestion's and, after an edit, the indicator's): the same library id or the same
 *   normalised name (me-foundations §2.9: one indicator per measurement);
 * - when the accepted row is an alternative of a suggestion: that source and the source's other alternatives; of an
 *   indicator: the other alternatives of that indicator;
 * - when it is a source: its pending alternatives.
 * Pure (exported for tests).
 */
export function siblingGroup(
  accepted: { id: string; resultIds: readonly string[]; libraryId: string | null; names: readonly string[];
    alternativeOfSuggestionId: string | null; alternativeOfIndicatorId: string | null },
  pending: ReadonlyArray<{ id: string; resultId: string | null; libraryId: string | null; name: string;
    alternativeOfSuggestionId: string | null; alternativeOfIndicatorId: string | null }>,
): string[] {
  const library = accepted.libraryId?.trim().toUpperCase() || null;
  const names = new Set(accepted.names.map(normalisedIndicatorName).filter(Boolean));
  return pending.filter(p => {
    if (p.id === accepted.id) return false;
    if (p.resultId && accepted.resultIds.includes(p.resultId)) {
      if (library && p.libraryId?.trim().toUpperCase() === library) return true;
      if (names.has(normalisedIndicatorName(p.name))) return true;
    }
    if (p.alternativeOfSuggestionId === accepted.id) return true;
    if (accepted.alternativeOfSuggestionId && (p.id === accepted.alternativeOfSuggestionId || p.alternativeOfSuggestionId === accepted.alternativeOfSuggestionId)) return true;
    if (accepted.alternativeOfIndicatorId && p.alternativeOfIndicatorId === accepted.alternativeOfIndicatorId) return true;
    return false;
  }).map(p => p.id);
}

/** True when `indicators` already hold one with this library id or this normalised name (409 duplicate). */
export function repeatsIndicator(indicators: ReadonlyArray<{ libraryId: string | null; indicatorText: string }>,
  candidate: { libraryId?: string | null; indicatorText?: string | null }): boolean {
  const library = candidate.libraryId?.trim().toUpperCase() || null;
  const name = normalisedIndicatorName(candidate.indicatorText ?? '');
  return indicators.some(i => (library !== null && i.libraryId?.trim().toUpperCase() === library)
    || (name !== '' && normalisedIndicatorName(i.indicatorText) === name));
}

const nameOf = (payload: unknown): string => (isObject(payload) && typeof payload.name === 'string' ? payload.name : '');

/**
 * Accept or edit & accept (design 8.1):
 * 1. load (organisation-scoped; 404); 2. not pending → 409 already_decided (expired → 409 stale);
 * 3. stale (framework no longer current, result deleted or its level changed) → expired + 409 stale;
 * 4. edits merged over the stored draft and parsed once (400 naming every failing field);
 * 5. one interactive transaction: the project's KPI lock first (lockProject; CC-03, CC-04), the archived rule on the
 *    share-locked project row (409 project_archived; the route's access check answered it already unless an archive
 *    committed in between), conditional decision (409 already_decided), staleness re-check with tx (409 stale and expired), sibling group expired (before any source
 *    indicator is deleted, so the group is still linked), duplicate check on the target result (409 duplicate),
 *    createIndicatorInFramework with provenance ai_suggested, the suggestion's model and prompt version (server-set even
 *    after edits), link;
 * 6. edited_accepted when editedFields is not empty, else accepted;
 * 7. donor cap (D5): the response warns donor_cap_exceeded when the result now has more indicators than the donor allows;
 *    accept is never blocked by the cap;
 * 8. `replaceSource: true` (SPEC-8; an alternative to an existing indicator): the source indicator is deleted in the same
 *    transaction (409 source_has_data when it holds data points or linked services; 409 stale and expired when another
 *    alternative already replaced it); the response names it (replacedIndicatorId), and the donor cap counts the result
 *    without it. The other alternatives of that indicator are expired first (sibling group), so they can never be
 *    accepted as extra indicators afterwards.
 */
export async function acceptKpiSuggestion(input: { suggestionId: string; organizationId: string; userId: string; body: unknown }):
  Promise<{ indicator: Prisma.IndicatorGetPayload<{ include: typeof INDICATOR_INCLUDE }>; suggestion: KpiSuggestionDto; warnings: KpiWarning[];
    replacedIndicatorId: string | null }> {
  const s = await prisma.kpiSuggestion.findFirst({
    where: { id: input.suggestionId, project: { organizationId: input.organizationId } },
    include: { project: { select: { id: true, donorType: true } }, result: { select: { id: true, level: true } } },
  });
  if (!s) throw new AppError(404, 'Suggestion not found');
  if (s.status === 'expired') throw new AppError(409, STALE_MESSAGE, 'stale');
  if (s.status !== 'pending') throw new AppError(409, DECIDED_MESSAGE, 'already_decided');

  const current = await findCurrentFramework(prisma, s.projectId);
  if (current?.id !== s.frameworkId || !s.resultId || !s.result || s.result.level !== s.level) {
    await expireSuggestion(s.id);
    throw new AppError(409, STALE_MESSAGE, 'stale');
  }

  const { edits, replaceSource } = parseAcceptBody(input.body);
  if (replaceSource && !s.alternativeOfIndicatorId) {
    throw new AppError(400, 'Invalid request: only an alternative to an existing indicator can replace it (replaceSource)');
  }
  const draft = storedDraft(s.payload);
  const createInput = draftToCreateInput(draft, edits);
  const status = editedFields(draft, edits).length > 0 ? 'edited_accepted' as const : 'accepted' as const;
  const sourceResultId = s.resultId;
  const targetResultId = createInput.resultId ?? null;

  let out;
  try {
    out = await prisma.$transaction(async tx => {
      // First, the project's KPI lock (CC-03, CC-04): an accept of a related card, a reject, or a run saving its cards
      // waits for this transaction, so related accepts never deadlock and a run never re-adds what was just accepted.
      await lockProject(tx, s.projectId);
      // The archived rule again on the project row (share lock): an archive that committed after the route's access
      // check refuses this accept (409 project_archived) and the suggestion stays pending; an archive waits for it.
      await assertProjectWritableLocked(tx, s.projectId);
      const now = new Date();
      const claimed = await tx.kpiSuggestion.updateMany({
        where: { id: s.id, status: 'pending' },
        data: { status, decidedAt: now, decidedBy: input.userId },
      });
      if (claimed.count !== 1) throw new AppError(409, DECIDED_MESSAGE, 'already_decided');

      const [currentNow, resultNow] = await Promise.all([
        findCurrentFramework(tx, s.projectId),
        tx.resultNode.findFirst({ where: { id: sourceResultId, frameworkId: s.frameworkId }, select: { level: true } }),
      ]);
      if (currentNow?.id !== s.frameworkId || !resultNow || resultNow.level !== s.level) throw new StaleSuggestion();

      // The sibling group is expired first, while the alternatives still point at their source indicator: deleting the
      // source (replaceSource) sets alternativeOfIndicatorId to null on them (ON DELETE SET NULL), and an unlinked sibling
      // could then be accepted as one more indicator (SPEC-8 re-check). A sibling accept waiting on the project lock then
      // finds its card expired (409).
      const resultIds = Array.from(new Set([sourceResultId, targetResultId].filter((r): r is string => !!r)));
      const groupLinks = [
        { alternativeOfSuggestionId: s.id },
        ...(s.alternativeOfSuggestionId ? [{ id: s.alternativeOfSuggestionId }, { alternativeOfSuggestionId: s.alternativeOfSuggestionId }] : []),
        ...(s.alternativeOfIndicatorId ? [{ alternativeOfIndicatorId: s.alternativeOfIndicatorId }] : []),
      ];
      const pending = await tx.kpiSuggestion.findMany({
        where: { frameworkId: s.frameworkId, status: 'pending', id: { not: s.id }, OR: [{ resultId: { in: resultIds } }, ...groupLinks] },
        select: { id: true, resultId: true, libraryId: true, payload: true, alternativeOfSuggestionId: true, alternativeOfIndicatorId: true },
      });
      const expireIds = siblingGroup(
        {
          id: s.id, resultIds, libraryId: createInput.libraryId ?? s.libraryId, names: [nameOf(s.payload), createInput.indicatorText ?? ''],
          alternativeOfSuggestionId: s.alternativeOfSuggestionId, alternativeOfIndicatorId: s.alternativeOfIndicatorId,
        },
        pending.map(p => ({ ...p, name: nameOf(p.payload) })),
      );
      if (expireIds.length > 0) {
        await tx.kpiSuggestion.updateMany({ where: { id: { in: expireIds }, status: 'pending' }, data: { status: 'expired' } });
      }

      // SPEC-8: the alternative replaces its source indicator (asked for by the officer), unless that indicator already
      // holds data or linked services. A source deleted meanwhile (another alternative replaced it) leaves this card stale.
      let replacedIndicatorId: string | null = null;
      if (replaceSource && s.alternativeOfIndicatorId) {
        const source = await tx.indicator.findFirst({
          where: { id: s.alternativeOfIndicatorId, frameworkId: s.frameworkId },
          select: { id: true, _count: { select: { dataPoints: true, beneficiaryServices: true } } },
        });
        if (!source) throw new StaleSuggestion();
        if (source._count.dataPoints > 0 || source._count.beneficiaryServices > 0) {
          throw new AppError(409, SOURCE_HAS_DATA_MESSAGE, 'source_has_data');
        }
        await tx.indicator.delete({ where: { id: source.id } });
        replacedIndicatorId = source.id;
      }

      if (targetResultId) {
        const onResult = await tx.indicator.findMany({
          where: { frameworkId: s.frameworkId, resultId: targetResultId },
          select: { libraryId: true, indicatorText: true },
        });
        if (repeatsIndicator(onResult, createInput)) {
          throw new AppError(409, 'This result already has an indicator with the same library id or the same name.', 'duplicate');
        }
      }

      const indicator = await createIndicatorInFramework(tx, s.frameworkId, createInput, {
        provenance: 'ai_suggested', aiModel: s.model, promptVersion: s.promptVersion,
      });
      const suggestion = await tx.kpiSuggestion.update({ where: { id: s.id }, data: { indicatorId: indicator.id } });

      const count = targetResultId ? await tx.indicator.count({ where: { frameworkId: s.frameworkId, resultId: targetResultId } }) : 0;
      return { indicator, suggestion, count, expired: expireIds.length, replacedIndicatorId };
    }, KPI_TRANSACTION_OPTIONS);
  } catch (err) {
    if (err instanceof StaleSuggestion) {
      await expireSuggestion(s.id);
      throw new AppError(409, STALE_MESSAGE, 'stale');
    }
    throw err;
  }

  const warnings: KpiWarning[] = [];
  const cap = donorRulesFor(s.project.donorType).maxIndicatorsPerResult;
  if (cap !== null && targetResultId && out.count > cap) {
    const code = redactPersonalData(out.indicator.result?.code ?? '').text;
    warnings.push(warning('donor_cap_exceeded', { code, cap, count: out.count }));
  }
  console.log(`[KpiAccept] ${s.id} ${status} → indicator ${out.indicator.id}; ${out.expired} related suggestions expired`
    + (out.replacedIndicatorId ? `; indicator ${out.replacedIndicatorId} replaced` : ''));
  return { indicator: out.indicator, suggestion: toSuggestionDto(out.suggestion), warnings, replacedIndicatorId: out.replacedIndicatorId };
}
