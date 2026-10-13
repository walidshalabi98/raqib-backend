import type { CollectionMethod, DonorType, SuggestionRejectReason, SuggestionStatus } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { seedLibrary } from '../src/services/library/seed';
import {
  REJECTION_SCOPE, loadOrgPreferences, preferenceWindowStart, preferredMethodsFrom, rejectedLibraryIdsFor,
} from '../src/services/kpi/preferences';
import type { PreferenceRow } from '../src/services/kpi/preferences';
import {
  createKpiRunRow, createKpiSuggestionRow, createOrgFixture, hasTestDatabase, kpiValidatedSuggestionFixture, resetDatabase,
} from './helpers';
import type { OrgFixture } from './helpers';

/** orgPreferences (spec §A3; BUILD_GUIDE Phase 4 criterion 4; design 8.3, D9). */

const TARGET = { projectId: 'p-target', donorType: 'eu' as DonorType };
let clock = Date.parse('2026-06-01T00:00:00Z');

function row(over: Partial<PreferenceRow> & { status: SuggestionStatus }): PreferenceRow {
  clock += 60_000;
  return {
    libraryId: 'WA-01', rejectReason: null, decidedAt: new Date(clock), projectId: TARGET.projectId, donorType: 'eu', method: 'hh_survey', ...over,
  };
}
const rejected = (reason: SuggestionRejectReason, over: Partial<PreferenceRow> = {}) => row({ status: 'rejected', rejectReason: reason, ...over });

describe('rejectedLibraryIdsFor (D9)', () => {
  it('every rejection excludes the library id in its own project', () => {
    for (const reason of Object.keys(REJECTION_SCOPE) as SuggestionRejectReason[]) {
      expect(rejectedLibraryIdsFor([rejected(reason)], TARGET)).toEqual(['WA-01']);
    }
  });

  it('not_relevant, too_costly_to_measure and other exclude it in every project of the organisation', () => {
    for (const reason of ['not_relevant', 'too_costly_to_measure', 'other'] as const) {
      expect(REJECTION_SCOPE[reason]).toBe('organisation');
      expect(rejectedLibraryIdsFor([rejected(reason, { projectId: 'p-other', donorType: 'unicef' })], TARGET)).toEqual(['WA-01']);
    }
  });

  it('donor_not_required excludes it in its own project and every project of the same donor type only', () => {
    expect(rejectedLibraryIdsFor([rejected('donor_not_required', { projectId: 'p-other', donorType: 'eu' })], TARGET)).toEqual(['WA-01']);
    expect(rejectedLibraryIdsFor([rejected('donor_not_required', { projectId: 'p-other', donorType: 'echo' })], TARGET)).toEqual([]);
  });

  it('duplicate and wording exclude it in their own project only', () => {
    for (const reason of ['duplicate', 'wording'] as const) {
      expect(rejectedLibraryIdsFor([rejected(reason, { projectId: 'p-other' })], TARGET)).toEqual([]);
    }
  });

  it('a later acceptance anywhere in the organisation lifts the exclusion; a later rejection restores it', () => {
    const first = rejected('not_relevant', { projectId: 'p-other' });
    const accept = row({ status: 'accepted', projectId: 'p-third', donorType: 'fcdo' });
    expect(rejectedLibraryIdsFor([accept, first].reverse(), TARGET)).toEqual([]);
    expect(rejectedLibraryIdsFor([first, accept, rejected('wording')], TARGET)).toEqual(['WA-01']);
    expect(rejectedLibraryIdsFor([first, row({ status: 'edited_accepted', projectId: 'p-third' })], TARGET)).toEqual([]);
    // An acceptance before the rejection does not lift it.
    expect(rejectedLibraryIdsFor([row({ status: 'accepted' }), rejected('other')], TARGET)).toEqual(['WA-01']);
  });

  it('a rejection that does not apply to the target never hides an earlier applicable acceptance', () => {
    const accept = row({ status: 'accepted' });
    expect(rejectedLibraryIdsFor([accept, rejected('wording', { projectId: 'p-other' })], TARGET)).toEqual([]);
  });

  it('on equal decision times the acceptance counts as later', () => {
    const at = new Date('2026-07-01T10:00:00Z');
    expect(rejectedLibraryIdsFor([rejected('other', { decidedAt: at }), row({ status: 'accepted', decidedAt: at })], TARGET)).toEqual([]);
    expect(rejectedLibraryIdsFor([row({ status: 'accepted', decidedAt: at }), rejected('other', { decidedAt: at })], TARGET)).toEqual([]);
  });

  it('ignores rows without a library id and undecided rows; ids are upper case, unique and sorted', () => {
    expect(rejectedLibraryIdsFor([
      rejected('other', { libraryId: null }),
      row({ status: 'expired', libraryId: 'FS-01' }),
      row({ status: 'pending', libraryId: 'FS-02' }),
      rejected('other', { libraryId: 'wa-03' }),
      rejected('other', { libraryId: 'AC-01' }),
      rejected('wording', { libraryId: 'AC-01' }),
    ], TARGET)).toEqual(['AC-01', 'WA-03']);
  });

  it('a rejection without a reason counts for its own project only', () => {
    expect(rejectedLibraryIdsFor([row({ status: 'rejected', rejectReason: null })], TARGET)).toEqual(['WA-01']);
    expect(rejectedLibraryIdsFor([row({ status: 'rejected', rejectReason: null, projectId: 'p-other' })], TARGET)).toEqual([]);
  });
});

describe('preferredMethodsFrom', () => {
  const decisions = (method: CollectionMethod, accepts: number, rejects: number, edited = 0): PreferenceRow[] => [
    ...Array.from({ length: accepts }, () => row({ status: 'accepted', method, libraryId: null })),
    ...Array.from({ length: edited }, () => row({ status: 'edited_accepted', method })),
    ...Array.from({ length: rejects }, () => rejected('other', { method })),
  ];

  it('needs at least 3 acceptances and an acceptance rate of at least 0.6 (edited acceptances count)', () => {
    expect(preferredMethodsFrom(decisions('hh_survey', 3, 2))).toEqual(['hh_survey']); // 3/5 = 0.6
    expect(preferredMethodsFrom(decisions('hh_survey', 3, 3))).toEqual([]); // 0.5
    expect(preferredMethodsFrom(decisions('hh_survey', 2, 0))).toEqual([]); // too few
    expect(preferredMethodsFrom(decisions('observation', 1, 1, 2))).toEqual(['observation']); // 3/4
  });

  it('orders by acceptances (then name), keeps at most 3 and ignores undecided rows', () => {
    const rows = [
      ...decisions('kii', 3, 0), ...decisions('hh_survey', 6, 1), ...decisions('document_review', 4, 0), ...decisions('fgd', 3, 0),
      ...Array.from({ length: 5 }, () => row({ status: 'expired', method: 'observation' })),
      ...Array.from({ length: 5 }, () => row({ status: 'pending', method: 'kii' })),
    ];
    expect(preferredMethodsFrom(rows)).toEqual(['hh_survey', 'document_review', 'fgd']);
  });
});

describe('preferenceWindowStart', () => {
  it('is 24 calendar months before now', () => {
    expect(preferenceWindowStart(new Date('2026-10-13T08:00:00Z')).toISOString()).toBe('2024-10-13T08:00:00.000Z');
  });
});

describe.skipIf(!hasTestDatabase)('loadOrgPreferences (database)', () => {
  let a: OrgFixture;
  let b: OrgFixture;
  const NOW = new Date('2026-10-13T08:00:00Z');

  beforeEach(async () => {
    await resetDatabase();
    // Suggestions reference library entries (foreign key).
    await seedLibrary(prisma, { logger: { warn: () => undefined } });
    a = await createOrgFixture('pref-a');
    b = await createOrgFixture('pref-b');
  });
  afterEach(async () => {
    await resetDatabase();
  });

  async function decide(fx: OrgFixture, input: {
    libraryId: string | null; status: SuggestionStatus; reason?: SuggestionRejectReason; decidedAt?: Date;
    method?: CollectionMethod; project?: { id: string; startDate: Date; endDate: Date };
  }) {
    const project = input.project ?? fx.project;
    const framework = project.id === fx.project.id ? fx.framework : await prisma.framework.findFirstOrThrow({ where: { projectId: project.id } });
    const result = project.id === fx.project.id ? fx.result : await prisma.resultNode.findFirstOrThrow({ where: { frameworkId: framework.id } });
    const run = await createKpiRunRow({ projectId: project.id, frameworkId: framework.id, resultId: result.id });
    return createKpiSuggestionRow({
      run,
      suggestion: kpiValidatedSuggestionFixture(result, undefined, {
        libraryId: input.libraryId, isCustom: input.libraryId === null, method: input.method ?? 'observation',
      }),
      status: input.status,
      decision: { decidedAt: input.decidedAt ?? new Date('2026-09-01T00:00:00Z'), rejectReason: input.reason ?? null, rejectNote: 'a note that is never read' },
    });
  }

  async function otherProject(fx: OrgFixture, donorType: DonorType) {
    const project = await prisma.project.create({
      data: { organizationId: fx.org.id, name: 'Other', sector: 'wash', donor: 'X', donorType, startDate: new Date('2026-01-01'), endDate: new Date('2027-12-31') },
    });
    const framework = await prisma.framework.create({ data: { projectId: project.id } });
    await prisma.resultNode.create({ data: { frameworkId: framework.id, level: 'outcome', code: 'O1', text: 'Outcome' } });
    return project;
  }

  const load = (fx: OrgFixture, projectId = fx.project.id, donorType: DonorType = 'eu') =>
    loadOrgPreferences(prisma, { organizationId: fx.org.id, projectId, donorType, now: NOW });

  it('reads only the organisation\'s own decisions: B\'s rejections never apply to A', async () => {
    await decide(b, { libraryId: 'WA-01', status: 'rejected', reason: 'not_relevant' });
    await decide(a, { libraryId: 'WA-02', status: 'rejected', reason: 'not_relevant' });
    expect((await load(a)).rejectedLibraryIds).toEqual(['WA-02']);
    expect((await load(b)).rejectedLibraryIds).toEqual(['WA-01']);
  });

  it('applies REJECTION_SCOPE across the organisation\'s projects and donor types', async () => {
    const sameDonor = await otherProject(a, 'eu');
    const otherDonor = await otherProject(a, 'echo');
    await decide(a, { libraryId: 'WA-01', status: 'rejected', reason: 'wording', project: sameDonor });
    await decide(a, { libraryId: 'WA-02', status: 'rejected', reason: 'donor_not_required', project: sameDonor });
    await decide(a, { libraryId: 'WA-03', status: 'rejected', reason: 'too_costly_to_measure', project: otherDonor });
    expect((await load(a)).rejectedLibraryIds).toEqual(['WA-02', 'WA-03']);
    expect((await load(a, otherDonor.id, 'echo')).rejectedLibraryIds).toEqual(['WA-03']);
    expect((await load(a, sameDonor.id, 'eu')).rejectedLibraryIds).toEqual(['WA-01', 'WA-02', 'WA-03']);
  });

  it('a later acceptance lifts an exclusion; decisions older than 24 months and pending rows are ignored', async () => {
    await decide(a, { libraryId: 'WA-01', status: 'rejected', reason: 'not_relevant', decidedAt: new Date('2026-08-01T00:00:00Z') });
    await decide(a, { libraryId: 'WA-01', status: 'accepted', decidedAt: new Date('2026-09-01T00:00:00Z') });
    await decide(a, { libraryId: 'WA-02', status: 'rejected', reason: 'not_relevant', decidedAt: new Date('2024-10-01T00:00:00Z') });
    expect((await load(a)).rejectedLibraryIds).toEqual([]);
    // The createOrgFixture suggestion is pending and has no library id: it never counts.
    expect(await prisma.kpiSuggestion.count({ where: { status: 'pending' } })).toBe(2);
  });

  it('preferredMethods from the organisation\'s decided rows of any library id', async () => {
    for (let i = 0; i < 3; i++) await decide(a, { libraryId: null, status: 'accepted', method: 'document_review' });
    await decide(a, { libraryId: 'WA-01', status: 'rejected', reason: 'other', method: 'document_review' });
    for (let i = 0; i < 4; i++) await decide(b, { libraryId: null, status: 'accepted', method: 'kii' });
    expect(await load(a)).toEqual({ rejectedLibraryIds: ['WA-01'], preferredMethods: ['document_review'] });
    expect((await load(b)).preferredMethods).toEqual(['kii']);
  });
});
