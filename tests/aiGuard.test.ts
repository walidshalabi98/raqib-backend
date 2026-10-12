import fs from 'fs';
import nodePath from 'path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Guards for CLAUDE.md rule 4 and the Phase 3 acceptance criteria: AI services choose a
 * tier, never a model id; parse nothing by hand; never import the SDK; and leave the shared
 * system prompt to the client. Only client.ts and models.ts may know about models and the SDK;
 * outputSchema.ts may import the SDK's JSON schema transform and nothing else from it.
 */

const ROOT = nodePath.resolve(__dirname, '..');
const AI_DIR = nodePath.join(ROOT, 'src/services/ai');
const EXEMPT = new Set(['client.ts', 'models.ts'].map(f => nodePath.join(AI_DIR, f)));
/** Builds the structured-output JSON schema with the SDK's transform; checked by every other rule. */
const OUTPUT_SCHEMA_FILE = nodePath.join(AI_DIR, 'outputSchema.ts');

interface Rule {
  name: string;
  pattern: RegExp;
  /** Files where the pattern is allowed (besides client.ts and models.ts). */
  allowedIn?: string[];
  /** Snippets the pattern must catch, so the guard is not vacuous. */
  catches: string[];
  /** Snippets it must leave alone. */
  allows: string[];
}

const RULES: Rule[] = [
  {
    name: 'hard-coded model id (use the tier: generateStructured({ model: "main" | "fast" }))',
    pattern: /claude-(opus|sonnet|haiku|fable|mythos)-\d/,
    catches: ["model: 'claude-sonnet-4-20250514',", 'const M = "claude-haiku-5-5";', 'claude-fable-5-1', 'claude-opus-5'],
    allows: ["model: 'main',", 'claude-sonnet (any tier)'],
  },
  {
    name: 'manual JSON cleaning (cleanJsonResponse)',
    pattern: /cleanJsonResponse/,
    catches: ['JSON.parse(cleanJsonResponse(text))', 'function cleanJsonResponse(text: string) {'],
    allows: ['const data = result.data;'],
  },
  {
    name: 'code-fence stripping (structured outputs return plain JSON)',
    pattern: /(?:\\?`){3}\s*json|(?:replace|startsWith|endsWith|slice|split)\([^)\n]*(?:\\?`){3}/i,
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
    name: 'Anthropic SDK import (call generateStructured in client.ts)',
    pattern: /(?:from\s+|require\(\s*|import\(\s*|import\s+)['"]@anthropic-ai\/sdk(?:\/[^'"]*)?['"]/,
    allowedIn: [OUTPUT_SCHEMA_FILE],
    catches: [
      "import Anthropic from '@anthropic-ai/sdk';",
      "import type { Message } from '@anthropic-ai/sdk/resources/messages';",
      "import { zodOutputFormat } from \"@anthropic-ai/sdk/helpers/zod\";",
      "const Anthropic = require('@anthropic-ai/sdk');",
      "await import('@anthropic-ai/sdk')",
      "import '@anthropic-ai/sdk';",
    ],
    allows: ["import { generateStructured } from './client';", "// see the @anthropic-ai/sdk changelog"],
  },
  {
    name: 'SYSTEM_CONTEXT (the client already sends the shared system prompt)',
    pattern: /\bSYSTEM_CONTEXT\b/,
    catches: ["import { SYSTEM_CONTEXT } from './prompts/system';", 'system: SYSTEM_CONTEXT,'],
    allows: ['const SYSTEM_CONTEXTUAL = 1;', 'system: FRAMEWORK_SYSTEM,'],
  },
];

function listTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

const scanned = listTsFiles(AI_DIR).filter(file => !EXEMPT.has(file));

/** "file:line: text" for every line of a scanned file that matches the rule. */
function offenders(rule: Rule): string[] {
  return scanned
    .filter(file => !(rule.allowedIn ?? []).includes(file))
    .flatMap(file =>
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => (rule.pattern.test(line) ? `${nodePath.relative(ROOT, file)}:${i + 1}: ${line.trim()}` : null))
        .filter((hit): hit is string => hit !== null),
    );
}

describe('AI service guard', () => {
  it('scans the AI services (and skips only client.ts and models.ts)', () => {
    const names = scanned.map(file => nodePath.relative(AI_DIR, file));
    expect(names).toEqual(expect.arrayContaining(['prompts/system.ts', 'errors.ts', 'outputSchema.ts']));
    expect(names).not.toContain('client.ts');
    expect(names).not.toContain('models.ts');
  });

  describe.each(RULES)('$name', rule => {
    it('catches the bad pattern and allows clean code', () => {
      for (const snippet of rule.catches) expect(rule.pattern.test(snippet), snippet).toBe(true);
      for (const snippet of rule.allows) expect(rule.pattern.test(snippet), snippet).toBe(false);
    });

    it('does not occur in src/services/ai (except client.ts and models.ts)', () => {
      expect(offenders(rule)).toEqual([]);
    });
  });
});

describe('outputSchema.ts', () => {
  it('imports only the SDK JSON schema transform (no client, no model calls)', () => {
    const sdkImports = fs.readFileSync(OUTPUT_SCHEMA_FILE, 'utf8').split('\n').filter(line => /@anthropic-ai\/sdk/.test(line) && !/^\s*(\*|\/\/)/.test(line));
    expect(sdkImports).toEqual(["import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';"]);
  });
});

describe('ESLint: Anthropic SDK imports', () => {
  const eslint = new ESLint({ cwd: ROOT });
  const source = "import Anthropic from '@anthropic-ai/sdk';\nimport { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';\nexport { Anthropic, zodOutputFormat };\n";

  async function restrictedImportErrors(filePath: string): Promise<number> {
    const [result] = await eslint.lintText(source, { filePath: nodePath.join(ROOT, filePath) });
    return result.messages.filter(m => m.ruleId === 'no-restricted-imports').length;
  }

  it('rejects the SDK in services and routes', async () => {
    expect(await restrictedImportErrors('src/services/ai/someService.ts')).toBe(2);
    expect(await restrictedImportErrors('src/routes/someRoute.ts')).toBe(2);
  });

  it('allows only the JSON schema transform in outputSchema.ts', async () => {
    expect(await restrictedImportErrors('src/services/ai/outputSchema.ts')).toBe(2);
    const [result] = await eslint.lintText(
      "import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';\nexport { transformJSONSchema };\n",
      { filePath: nodePath.join(ROOT, 'src/services/ai/outputSchema.ts') },
    );
    expect(result.messages.filter(m => m.ruleId === 'no-restricted-imports')).toEqual([]);
  });

  it('allows the SDK in client.ts, models.ts and tests', async () => {
    expect(await restrictedImportErrors('src/services/ai/client.ts')).toBe(0);
    expect(await restrictedImportErrors('src/services/ai/models.ts')).toBe(0);
    expect(await restrictedImportErrors('tests/someTest.test.ts')).toBe(0);
  });
});
