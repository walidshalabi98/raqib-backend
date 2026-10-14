import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { ENV_VARIABLE_NAMES } from '../src/config/env';

/**
 * The documentation says what the code does: the README lists every AI setting, the BUILD_GUIDE status row of Phase 4
 * names the same merged pull requests in both repos, and docs/SECURITY_SETUP.md names every write that checks the
 * archived rule again under the project lock.
 */

const ROOT = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('README: optional AI settings', () => {
  const aiSettings = ENV_VARIABLE_NAMES.filter(name => /^(AI|VOYAGE)_/.test(name));

  it('the table and .env.example list every AI setting of the configuration', () => {
    expect(aiSettings).toEqual(expect.arrayContaining(['AI_MODEL_MAIN', 'AI_CALL_RETENTION_MONTHS', 'AI_ORG_DAILY_BUDGET_USD', 'VOYAGE_API_KEY']));
    const [, afterHeading = ''] = read('README.md').split('Optional AI settings (defaults in brackets):');
    const rows = afterHeading.trimStart().split('\n\n')[0].split('\n').filter(line => line.startsWith('| `'));
    const documented = rows.map(line => /^\| `([A-Z_]+)`/.exec(line)?.[1]);
    expect(documented.sort()).toEqual([...aiSettings].sort());
    const example = read('.env.example');
    for (const name of aiSettings) expect(example).toMatch(new RegExp(`^${name}=`, 'm'));
  });
});

/** "#8–#11" → [8, 9, 10, 11]; "#9" → [9]. */
function pullRequests(range: string): number[] {
  const match = /^#(\d+)(?:[–-]#(\d+))?$/.exec(range.trim());
  if (!match) throw new Error(`not a pull request range: ${range}`);
  const first = Number(match[1]);
  const last = match[2] ? Number(match[2]) : first;
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/**
 * The pull requests of each repo that the Phase 4 status row says the branch has merged in from main; null once the row
 * no longer says it (after Phase 4 merges).
 */
function phase4MergedPullRequests(buildGuide: string): { backend: number[]; frontend: number[] } | null {
  const row = buildGuide.split('\n').find(line => line.startsWith('| 4 KPI Assistant |'));
  if (!row) throw new Error('no Phase 4 status row');
  const merged = /The branch has main merged \(([^)]*)\)/.exec(row)?.[1];
  if (!merged) return null;
  const of = (repo: 'backend' | 'frontend') => {
    const range = new RegExp(`${repo} (#\\d+(?:[–-]#\\d+)?)`).exec(merged)?.[1];
    if (!range) throw new Error(`the Phase 4 status row names no ${repo} pull requests`);
    return pullRequests(range);
  };
  return { backend: of('backend'), frontend: of('frontend') };
}

describe('docs/BUILD_GUIDE.md: Phase 4 status row', () => {
  const frontendGuide = path.join(ROOT, '..', 'raqib-frontend', 'docs', 'BUILD_GUIDE.md');

  // The same file is kept in both repos (BUILD_GUIDE line 5). With the frontend repo checked out next to this one (as in
  // the development setup; CI checks out this repo only), the two Phase 4 rows must name the same merged pull requests.
  it.skipIf(!fs.existsSync(frontendGuide))('names the same pull requests merged in from main as the frontend copy of the guide', () => {
    const backend = phase4MergedPullRequests(read('docs/BUILD_GUIDE.md'));
    expect(backend).toEqual(phase4MergedPullRequests(fs.readFileSync(frontendGuide, 'utf8')));
  });
});

describe('docs/SECURITY_SETUP.md: writes that check the archived rule again under the project lock', () => {
  /** Source files (under src/) that call assertProjectWritableLocked, the second check inside a transaction. */
  function lockedCheckCallers(dir = path.join(ROOT, 'src')): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return lockedCheckCallers(file);
      if (!entry.name.endsWith('.ts') || entry.name === 'access.ts') return [];
      return /assertProjectWritableLocked\(/.test(fs.readFileSync(file, 'utf8')) ? [path.relative(ROOT, file)] : [];
    });
  }

  it('§8.6 item 15 names the KPI Assistant writes the code checks again (run creation, accept, reject), as §5 does', () => {
    expect(lockedCheckCallers().sort()).toEqual(['src/services/kpi/accept.ts', 'src/services/kpi/reject.ts', 'src/services/kpi/runs.ts']);
    const doc = read('docs/SECURITY_SETUP.md');
    const item15 = doc.split('\n').find(line => line.startsWith('15. Archived projects'));
    expect(item15).toBeDefined();
    const clause = /only the writes that change the project's status([^;.]*?)check again under the project lock/.exec(item15!);
    expect(clause).not.toBeNull();
    expect(clause![1]).toContain("the KPI Assistant's run creation, accept and reject");
    expect(doc).toContain('check the rule a second time as well, inside their transaction on the project row under a share lock (`assertProjectWritableLocked`)');
  });
});
