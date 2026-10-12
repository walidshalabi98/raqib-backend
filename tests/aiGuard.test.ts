import fs from 'fs';
import nodePath from 'path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Guards for CLAUDE.md rule 4 and the Phase 3 acceptance criteria: code chooses a tier, never a
 * model id; parses nothing by hand; never imports the SDK (statically or dynamically); and leaves
 * the shared system prompt to the client. Only client.ts and models.ts may know about models and
 * the SDK; outputSchema.ts may import the SDK's JSON schema transform and nothing else from it.
 *
 * Scanned: every source file under src/, scripts/ and prisma/ (tests are not scanned: they fake
 * the SDK and name models on purpose).
 */

const ROOT = nodePath.resolve(__dirname, '..');
const SCAN_DIRS = ['src', 'scripts', 'prisma'];
const AI_DIR = nodePath.join(ROOT, 'src/services/ai');
const EXEMPT = new Set(['client.ts', 'models.ts'].map(f => nodePath.join(AI_DIR, f)));
/** Builds the structured-output JSON schema with the SDK's transform; checked by every other rule. */
const OUTPUT_SCHEMA_FILE = nodePath.join(AI_DIR, 'outputSchema.ts');
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** Lines a rule allows in one file, and how many such lines may exist at most (so an exemption cannot grow). */
interface AllowedLines {
  file: string;
  line: RegExp;
  max: number;
}

interface Rule {
  name: string;
  pattern: RegExp;
  /** 'all': src/, scripts/ and prisma/; 'ai': src/services/ai only. */
  scope: 'all' | 'ai';
  /** Files (relative to the repo root) where the pattern is allowed, besides client.ts and models.ts. */
  allowedIn?: string[];
  /** Single lines where the pattern is allowed. */
  allowedLines?: AllowedLines[];
  /** Snippets the pattern must catch, so the guard is not vacuous. */
  catches: string[];
  /** Snippets it must leave alone. */
  allows: string[];
}

const RULES: Rule[] = [
  {
    name: 'hard-coded model id (use the tier: generateStructured({ model: "main" | "fast" }))',
    pattern: /claude-(opus|sonnet|haiku|fable|mythos)-\d/,
    scope: 'all',
    allowedLines: [
      // The defaults of AI_MODEL_MAIN / AI_MODEL_FAST: the one place a deployment's model ids come from.
      { file: 'src/config/env.ts', line: /^\s*AI_MODEL_(MAIN|FAST): /, max: 2 },
      // Documented sample history: the model recorded on seeded AI-generated frameworks (never called).
      { file: 'prisma/seed.ts', line: /^const SEED_AI_MODEL = '/, max: 1 },
    ],
    catches: ["model: 'claude-sonnet-4-20250514',", 'const M = "claude-haiku-5-5";', 'claude-fable-5-1', 'claude-opus-5', 'aiModelUsed: `claude-sonnet-5-5`'],
    allows: ["model: 'main',", 'claude-sonnet (any tier)', 'aiModelUsed: result.model,'],
  },
  {
    name: 'manual JSON cleaning (cleanJsonResponse)',
    pattern: /cleanJsonResponse/,
    scope: 'all',
    catches: ['JSON.parse(cleanJsonResponse(text))', 'function cleanJsonResponse(text: string) {'],
    allows: ['const data = result.data;'],
  },
  {
    name: 'code-fence stripping (structured outputs return plain JSON)',
    pattern: /(?:\\?`){3}\s*json|(?:replace|startsWith|endsWith|slice|split)\([^)\n]*(?:\\?`){3}/i,
    scope: 'ai',
    catches: [
      "text.replace(/```json\\n?/g, '')",
      "if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);",
      "if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);",
      'Do not wrap the answer in \\`\\`\\`json fences',
      'Return ```JSON only',
    ],
    allows: ['const text = blocks.join("");', '`template ${value}`'],
  },
  {
    name: 'Anthropic SDK import, static or dynamic (call generateStructured in client.ts)',
    pattern: /(?:from\s+|require\(\s*|import\(\s*|import\s+)['"`]@anthropic-ai\/[^'"`]*['"`]/,
    scope: 'all',
    allowedIn: [nodePath.relative(ROOT, OUTPUT_SCHEMA_FILE)],
    catches: [
      "import Anthropic from '@anthropic-ai/sdk';",
      "import type { Message } from '@anthropic-ai/sdk/resources/messages';",
      "import { zodOutputFormat } from \"@anthropic-ai/sdk/helpers/zod\";",
      "const Anthropic = require('@anthropic-ai/sdk');",
      "await import('@anthropic-ai/sdk')",
      'const { default: Anthropic } = await import(`@anthropic-ai/sdk`);',
      "const sdk = await import( '@anthropic-ai/sdk/client' );",
      "import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';",
      "import '@anthropic-ai/sdk';",
    ],
    allows: ["import { generateStructured } from './client';", '// see the @anthropic-ai/sdk changelog', "await import('./client')"],
  },
  {
    name: 'SYSTEM_CONTEXT (the client already sends the shared system prompt)',
    pattern: /\bSYSTEM_CONTEXT\b/,
    scope: 'all',
    catches: ["import { SYSTEM_CONTEXT } from './prompts/system';", 'system: SYSTEM_CONTEXT,'],
    allows: ['const SYSTEM_CONTEXTUAL = 1;', 'system: FRAMEWORK_SYSTEM,'],
  },
  {
    name: 'shared system prompt loaded outside the client (services send only their own instructions)',
    pattern: /\b(?:load|build)SharedSystemPrompt\b/,
    scope: 'all',
    // Defined in prompts/system.ts; built at startup by the API and the worker so a broken knowledge file stops them.
    allowedIn: ['src/services/ai/prompts/system.ts', 'src/index.ts', 'src/jobs/worker.ts'],
    catches: [
      "import { loadSharedSystemPrompt } from './prompts/system';",
      'system: `${loadSharedSystemPrompt().text}\\n\\n${FEATURE_SYSTEM}`,',
      'const shared = buildSharedSystemPrompt();',
    ],
    allows: ['system: FEATURE_SYSTEM,', 'const sharedSystemPromptVersion = row.systemPromptVersion;'],
  },
];

function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSourceFiles(full);
    return entry.isFile() && SOURCE_EXTENSIONS.some(ext => entry.name.endsWith(ext)) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

const scanned = SCAN_DIRS.flatMap(dir => listSourceFiles(nodePath.join(ROOT, dir))).filter(file => !EXEMPT.has(file));

function filesFor(rule: Rule): string[] {
  return scanned
    .filter(file => rule.scope === 'all' || file.startsWith(AI_DIR + nodePath.sep))
    .filter(file => !(rule.allowedIn ?? []).includes(nodePath.relative(ROOT, file)));
}

/** "file:line: text" for every line of a scanned file that matches the rule (allowed lines excluded). */
function offenders(rule: Rule): string[] {
  return filesFor(rule).flatMap(file => {
    const relative = nodePath.relative(ROOT, file);
    const allowed = (rule.allowedLines ?? []).filter(a => a.file === relative);
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line, i) => (rule.pattern.test(line) && !allowed.some(a => a.line.test(line)) ? `${relative}:${i + 1}: ${line.trim()}` : null))
      .filter((hit): hit is string => hit !== null);
  });
}

describe('AI guard', () => {
  it('scans src/, scripts/ and prisma/ (and skips only client.ts and models.ts)', () => {
    const names = scanned.map(file => nodePath.relative(ROOT, file));
    expect(names).toEqual(expect.arrayContaining([
      'src/services/ai/prompts/system.ts',
      'src/services/ai/errors.ts',
      'src/services/ai/outputSchema.ts',
      'src/routes/frameworks.ts',
      'src/jobs/worker.ts',
      'src/config/env.ts',
      'scripts/ai-smoke.ts',
      'prisma/seed.ts',
    ]));
    expect(names).not.toContain('src/services/ai/client.ts');
    expect(names).not.toContain('src/services/ai/models.ts');
    expect(names.some(name => name.startsWith('tests/'))).toBe(false);
  });

  describe.each(RULES)('$name', rule => {
    it('catches the bad pattern and allows clean code', () => {
      for (const snippet of rule.catches) expect(rule.pattern.test(snippet), snippet).toBe(true);
      for (const snippet of rule.allows) expect(rule.pattern.test(snippet), snippet).toBe(false);
    });

    it(`does not occur in ${rule.scope === 'all' ? 'src/, scripts/ or prisma/' : 'src/services/ai'} (except where allowed)`, () => {
      expect(offenders(rule)).toEqual([]);
    });
  });

  it('keeps the allowed model-id lines to the env defaults and the seed sample constant', () => {
    const rule = RULES[0];
    for (const allowed of rule.allowedLines ?? []) {
      const file = nodePath.join(ROOT, allowed.file);
      const hits = fs.readFileSync(file, 'utf8').split('\n').filter(line => allowed.line.test(line) && rule.pattern.test(line));
      expect(hits.length, allowed.file).toBeLessThanOrEqual(allowed.max);
    }
    // The env defaults are the model ids a deployment gets when AI_MODEL_MAIN / AI_MODEL_FAST are unset.
    const env = fs.readFileSync(nodePath.join(ROOT, 'src/config/env.ts'), 'utf8').split('\n');
    expect(env.filter(line => /^\s*AI_MODEL_(MAIN|FAST): /.test(line) && rule.pattern.test(line))).toHaveLength(2);
  });

  it('would flag a model id in a route, a dynamic SDK import in a job and a loaded system prompt in a script', () => {
    const [modelId, , , sdkImport, , systemPrompt] = RULES;
    expect(modelId.pattern.test("data: { aiModelUsed: 'claude-sonnet-5-5' }")).toBe(true);
    expect(sdkImport.pattern.test("const { default: Anthropic } = await import('@anthropic-ai/sdk');")).toBe(true);
    expect(systemPrompt.pattern.test('const prompt = loadSharedSystemPrompt().text;')).toBe(true);
    // Routes, jobs and scripts are scanned by every 'all' rule.
    for (const file of ['src/routes/frameworks.ts', 'src/jobs/worker.ts', 'scripts/ai-smoke.ts']) {
      expect(filesFor(modelId).map(f => nodePath.relative(ROOT, f))).toContain(file);
      expect(filesFor(sdkImport).map(f => nodePath.relative(ROOT, f))).toContain(file);
    }
    expect(filesFor(systemPrompt).map(f => nodePath.relative(ROOT, f))).toContain('scripts/ai-smoke.ts');
    expect(filesFor(systemPrompt).map(f => nodePath.relative(ROOT, f))).not.toContain('src/jobs/worker.ts');
  });
});

describe('outputSchema.ts', () => {
  it('imports only the SDK JSON schema transform (no client, no model calls)', () => {
    const sdkImports = fs.readFileSync(OUTPUT_SCHEMA_FILE, 'utf8').split('\n').filter(line => /@anthropic-ai\//.test(line) && !/^\s*(\*|\/\/)/.test(line));
    expect(sdkImports).toEqual(["import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';"]);
  });
});

describe('ESLint: Anthropic SDK imports', () => {
  const eslint = new ESLint({ cwd: ROOT });
  const staticImports = "import Anthropic from '@anthropic-ai/sdk';\nimport { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';\nexport { Anthropic, zodOutputFormat };\n";
  const dynamicImports = [
    "export async function a() { return import('@anthropic-ai/sdk'); }",
    'export async function b() { return import(`@anthropic-ai/sdk/helpers/zod`); }',
    "export async function c() { return import('@anthropic-ai/bedrock-sdk'); }",
    '',
  ].join('\n');

  async function errors(source: string, filePath: string, ruleId: string): Promise<number> {
    const [result] = await eslint.lintText(source, { filePath: nodePath.join(ROOT, filePath) });
    return result.messages.filter(m => m.ruleId === ruleId).length;
  }

  it('rejects static SDK imports in services, routes, scripts and the seed', async () => {
    for (const file of ['src/services/ai/someService.ts', 'src/routes/someRoute.ts', 'src/jobs/someJob.ts', 'scripts/eval-kpi.ts', 'prisma/seed2.ts']) {
      expect(await errors(staticImports, file, 'no-restricted-imports'), file).toBe(2);
    }
    expect(await errors("import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';\nexport { AnthropicVertex };\n", 'src/routes/someRoute.ts', 'no-restricted-imports')).toBe(1);
  });

  it('rejects dynamic import() and require() of the SDK everywhere but client.ts and models.ts', async () => {
    for (const file of ['src/routes/someRoute.ts', 'src/services/kpi/assistant.ts', 'src/services/ai/outputSchema.ts', 'scripts/eval-kpi.ts', 'prisma/seed2.ts']) {
      expect(await errors(dynamicImports, file, 'no-restricted-syntax'), file).toBe(3);
    }
    expect(await errors("const A = require('@anthropic-ai/sdk');\nexport { A };\n", 'scripts/eval-kpi.ts', 'no-restricted-syntax')).toBe(1);
    expect(await errors("export async function f() { return import('./client'); }\n", 'src/routes/someRoute.ts', 'no-restricted-syntax')).toBe(0);
  });

  it('allows only the JSON schema transform in outputSchema.ts', async () => {
    expect(await errors(staticImports, 'src/services/ai/outputSchema.ts', 'no-restricted-imports')).toBe(2);
    const transform = "import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';\nexport { transformJSONSchema };\n";
    expect(await errors(transform, 'src/services/ai/outputSchema.ts', 'no-restricted-imports')).toBe(0);
  });

  it('allows the SDK in client.ts, models.ts and tests', async () => {
    for (const file of ['src/services/ai/client.ts', 'src/services/ai/models.ts', 'tests/someTest.test.ts']) {
      expect(await errors(staticImports, file, 'no-restricted-imports'), file).toBe(0);
      expect(await errors(dynamicImports, file, 'no-restricted-syntax'), file).toBe(0);
    }
  });
});
