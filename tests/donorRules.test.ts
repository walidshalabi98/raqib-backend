import { DonorType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { DONOR_RULES, donorRulesFor } from '../src/services/ai/donorRules';
import { loadLibraryFile } from '../src/services/library/load';

/** Donor rules of the KPI Assistant (spec §A3 donorRules; me-foundations §10; design section 4.3). */
describe('donorRulesFor', () => {
  const libraryFrameworks = new Set(loadLibraryFile().entries.map(e => e.standardReference?.framework).filter(Boolean));

  it('every DonorType has rules, un_women included, and nothing else', () => {
    expect(Object.keys(DONOR_RULES).sort()).toEqual(Object.values(DonorType).sort());
    expect(Object.values(DonorType)).toHaveLength(12);
    for (const donorType of Object.values(DonorType)) {
      const rules = donorRulesFor(donorType);
      expect(rules.donorType).toBe(donorType);
      expect(rules.maxIndicatorsPerResult === null || rules.maxIndicatorsPerResult > 0).toBe(true);
    }
  });

  it('requiredFrameworks map to library standardFramework values (every libraryFrameworks value exists in the library file)', () => {
    for (const donorType of Object.values(DonorType)) {
      for (const framework of donorRulesFor(donorType).libraryFrameworks) expect(libraryFrameworks.has(framework)).toBe(true);
    }
  });

  it('follows the design table', () => {
    expect(donorRulesFor('eu')).toMatchObject({
      maxIndicatorsPerResult: null, requiredFrameworks: ['GERF Level 2', 'GAP III'], libraryFrameworks: ['EU GERF'],
    });
    expect(donorRulesFor('eu').notes).toHaveLength(2);
    // DG ECHO: 3 indicators per result (D5); no ECHO KRIs in the library yet.
    expect(donorRulesFor('echo')).toMatchObject({ maxIndicatorsPerResult: 3, requiredFrameworks: ['ECHO KRIs'], libraryFrameworks: [] });
    expect(donorRulesFor('echo').notes.join(' ')).toMatch(/Baseline compulsory/);
    for (const agency of ['undp', 'unicef', 'unfpa', 'un_women'] as const) {
      expect(donorRulesFor(agency)).toMatchObject({ requiredFrameworks: ['Agency strategic plan', 'SDG'], libraryFrameworks: ['SDG'], maxIndicatorsPerResult: null });
    }
    expect(donorRulesFor('un_women').notes.join(' ')).toMatch(/SDG 5/);
    expect(donorRulesFor('wfp').libraryFrameworks).toEqual(['SDG', 'WFP', 'WFP CARI']);
    for (const other of ['giz', 'sida', 'fcdo', 'other'] as const) {
      expect(donorRulesFor(other)).toMatchObject({ requiredFrameworks: ['Sector standards'], libraryFrameworks: [], notes: [], maxIndicatorsPerResult: null });
    }
    // USAID is a legacy donor type (CLAUDE.md context: awards no longer administered since 1 July 2025).
    expect(donorRulesFor('usaid')).toMatchObject({ requiredFrameworks: [], libraryFrameworks: [], maxIndicatorsPerResult: null });
    expect(donorRulesFor('usaid').notes.join(' ')).toMatch(/Legacy/);
  });

  it('returns copies: changing the result never changes DONOR_RULES', () => {
    const rules = donorRulesFor('undp');
    rules.libraryFrameworks.push('EU GERF');
    rules.requiredFrameworks.length = 0;
    rules.notes.push('changed');
    expect(donorRulesFor('undp')).toMatchObject({ requiredFrameworks: ['Agency strategic plan', 'SDG'], libraryFrameworks: ['SDG'] });
    expect(donorRulesFor('unicef').requiredFrameworks).toEqual(['Agency strategic plan', 'SDG']);
    expect(DONOR_RULES.undp.notes).toEqual(['Align with SDG codes where possible.']);
  });

  it('an unknown donor type gets the rules of other', () => {
    const rules = donorRulesFor('world_bank' as DonorType);
    expect(rules).toMatchObject({ donorType: 'world_bank', requiredFrameworks: ['Sector standards'], libraryFrameworks: [], maxIndicatorsPerResult: null });
  });
});
