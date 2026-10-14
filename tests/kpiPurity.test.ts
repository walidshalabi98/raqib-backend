import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The KPI Assistant's pure modules never load the environment, the database client or the AI client (design 4.2
 * "Import rule"; CLAUDE.md rule 7: deterministic checks are pure functions). The eval (npm run eval:kpi) and the unit
 * tests import them without a database or a key. Type-only imports are allowed; every value import is followed, so a
 * forbidden module reached through another module fails too.
 */

const ROOT = path.resolve(__dirname, '..');
const src = (p: string) => path.join(ROOT, 'src', p);

/** E2 and E3 pure modules (design 4.2): validation core, donor rules, document facts, retrieval, library source, preferences. */
const PURE_MODULES = [
  'services/kpi/types.ts',
  'services/kpi/scope.ts',
  'services/kpi/accountability.ts',
  'services/kpi/nameRules.ts',
  'services/kpi/validate.ts',
  'services/kpi/draft.ts',
  'services/ai/donorRules.ts',
  'services/kpi/documentFacts.ts',
  'services/kpi/retrieve.ts',
  'services/kpi/librarySource.ts',
  'services/kpi/preferences.ts',
].map(src);

const FORBIDDEN = new Map([
  [src('config/env.ts'), 'src/config/env'],
  [src('config/prisma.ts'), 'src/config/prisma'],
  [src('services/ai/client.ts'), 'src/services/ai/client'],
]);

/** Module specifiers a file loads at run time: value imports and re-exports, side-effect imports, require() and import(). */
function valueImports(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const allNamedTypeOnly = !!named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(e => e.isTypeOnly);
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && allNamedTypeOnly));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause;
      const allNamedTypeOnly = !!named && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every(e => e.isTypeOnly);
      if (!node.isTypeOnly && !allNamedTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression) && !node.isTypeOnly) {
      out.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** A relative specifier resolved to a source file of this repo; null for packages. */
function resolve(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The first chain of value imports from `start` to a forbidden module, or null. */
function forbiddenChain(start: string): string[] | null {
  const seen = new Set<string>([start]);
  const queue: string[][] = [[start]];
  while (queue.length > 0) {
    const chain = queue.shift()!;
    const file = chain[chain.length - 1];
    for (const specifier of valueImports(file)) {
      const target = resolve(file, specifier);
      if (target === null) continue;
      if (FORBIDDEN.has(target)) return [...chain, target];
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push([...chain, target]);
    }
  }
  return null;
}

const rel = (file: string) => path.relative(ROOT, file);

describe('KPI pure modules (design 4.2 import rule)', () => {
  it.each(PURE_MODULES.map(file => [rel(file), file]))('%s exists and imports no env, prisma or AI client, directly or through another module', (_name, file) => {
    expect(fs.existsSync(file)).toBe(true);
    const chain = forbiddenChain(file);
    expect(chain?.map(rel) ?? null).toBeNull();
  });

  it('the checker sees value imports and ignores type-only ones', () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kpi-purity-'));
    try {
      const file = path.join(dir, 'sample.ts');
      fs.writeFileSync(file, [
        "import type { A } from './typeOnly';",
        "import { type B, type C } from './inlineTypes';",
        "import { D } from './value';",
        "import { type E, F } from './mixed';",
        "export { G } from './reexport';",
        "export type { H } from './typeReexport';",
        "import './sideEffect';",
        "const lazy = () => import('./dynamic');",
        "const old = require('./required');",
      ].join('\n'));
      expect(valueImports(file)).toEqual(['./value', './mixed', './reexport', './sideEffect', './dynamic', './required']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the checker finds a forbidden module reached through another module', () => {
    // reportNarrative.ts loads the AI client (and with it env and prisma): the checker must see that chain.
    const chain = forbiddenChain(src('services/ai/reportNarrative.ts'));
    expect(chain).not.toBeNull();
    expect(FORBIDDEN.has(chain![chain!.length - 1])).toBe(true);
  });
});
