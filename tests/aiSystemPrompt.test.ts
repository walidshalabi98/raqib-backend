import fs from 'fs';
import os from 'os';
import nodePath from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSharedSystemPromptCache,
  DEFAULT_FOUNDATIONS_PATH,
  loadSharedSystemPrompt,
  ROLE_PROMPT,
  SYSTEM_PROMPT_VERSION,
} from '../src/services/ai/prompts/system';

const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'raqib-foundations-'));
let fileCounter = 0;

function sections(numbers: number[]): string {
  return numbers.map(n => `## ${n}. Section ${n} heading\n\nRule text for section ${n}.\n`).join('\n');
}

function foundationsFile(body: string): string {
  fileCounter += 1;
  const file = nodePath.join(dir, `foundations-${fileCounter}.md`);
  fs.writeFileSync(file, body);
  return file;
}

const ALL = Array.from({ length: 12 }, (_, i) => i + 1);
const SAMPLE = `# Test Foundations\n\nIntro for developers: not for the model.\n\n---\n\n${sections(ALL)}\n---\n\n## 13. Sources (checked October 2026)\n\n- https://example.org/source\n\n## 14. Appendix\n\nMore text.\n`;

beforeEach(() => {
  clearSharedSystemPromptCache();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  clearSharedSystemPromptCache();
});

describe('loadSharedSystemPrompt', () => {
  it('keeps the role, the title and sections 1–12, and drops the introduction and §13 onwards', () => {
    const { text } = loadSharedSystemPrompt(foundationsFile(SAMPLE));
    expect(text.startsWith(ROLE_PROMPT)).toBe(true);
    expect(text).toContain('# Test Foundations');
    for (const n of ALL) expect(text).toContain(`## ${n}. Section ${n} heading`);
    expect(text).toContain('Rule text for section 12.');
    expect(text).not.toContain('Intro for developers');
    expect(text).not.toContain('## 13.');
    expect(text).not.toContain('example.org');
    expect(text).not.toContain('## 14.');
    expect(text.trimEnd().endsWith('Rule text for section 12.')).toBe(true);
  });

  it('keeps sub-headings inside a section', () => {
    const body = SAMPLE.replace('Rule text for section 10.', 'Rule text for section 10.\n\n### Key sector references\n\n- Sphere');
    const { text } = loadSharedSystemPrompt(foundationsFile(body));
    expect(text).toContain('### Key sector references');
  });

  it('works when §12 is the last section', () => {
    const { text } = loadSharedSystemPrompt(foundationsFile(`# Title\n\n${sections(ALL)}`));
    expect(text).toContain('## 12. Section 12 heading');
  });

  it('versions the prompt by its content', () => {
    const a = loadSharedSystemPrompt(foundationsFile(SAMPLE));
    const b = loadSharedSystemPrompt(foundationsFile(SAMPLE));
    const changed = loadSharedSystemPrompt(foundationsFile(SAMPLE.replace('Rule text for section 6.', 'Changed rule for section 6.')));
    const onlySourcesChanged = loadSharedSystemPrompt(foundationsFile(SAMPLE.replace('https://example.org/source', 'https://example.org/other')));

    expect(a.version).toMatch(new RegExp(`^${SYSTEM_PROMPT_VERSION}-[0-9a-f]{10}$`));
    expect(SYSTEM_PROMPT_VERSION).toBe('system-v1');
    expect(b.version).toBe(a.version);
    expect(changed.version).not.toBe(a.version);
    // §13 is not sent, so editing it does not change the prompt version.
    expect(onlySourcesChanged.version).toBe(a.version);
  });

  it('caches the result per path', () => {
    const file = foundationsFile(SAMPLE);
    const first = loadSharedSystemPrompt(file);
    fs.writeFileSync(file, SAMPLE.replace('section 3.', 'section three.'));
    expect(loadSharedSystemPrompt(file)).toBe(first);
    clearSharedSystemPromptCache();
    expect(loadSharedSystemPrompt(file).version).not.toBe(first.version);
  });

  it('throws a clear error when a section is missing', () => {
    const body = `# Title\n\n${sections(ALL.filter(n => n !== 7 && n !== 12))}`;
    expect(() => loadSharedSystemPrompt(foundationsFile(body))).toThrow(/missing section\(s\) "## 7\.", "## 12\."/);
  });

  it('does not mistake "## 10." for "## 1."', () => {
    const body = `# Title\n\n${sections(ALL.filter(n => n !== 1))}`;
    expect(() => loadSharedSystemPrompt(foundationsFile(body))).toThrow(/"## 1\."/);
  });

  it('throws a clear error when the file has no title', () => {
    expect(() => loadSharedSystemPrompt(foundationsFile(sections(ALL)))).toThrow(/no "# " title/);
  });

  it('throws a clear error when the file cannot be read', () => {
    expect(() => loadSharedSystemPrompt(nodePath.join(dir, 'missing.md'))).toThrow(/Cannot read the M&E foundations file.*ENOENT/);
  });

  it('loads the real knowledge file', () => {
    expect(DEFAULT_FOUNDATIONS_PATH.endsWith(nodePath.join('knowledge', 'me-foundations.md'))).toBe(true);
    const { text, version } = loadSharedSystemPrompt();
    expect(text).toContain('# Raqib M&E Knowledge Base — Foundations');
    expect(text).toContain('## 1. Core vocabulary');
    expect(text).toContain('## 6. Baselines and targets');
    expect(text).toContain('## 11. Palestine context rules for the AI');
    expect(text).toContain('## 12. Privacy rules for the AI pipeline');
    expect(text).not.toContain('## 13. Sources');
    expect(text).not.toContain('https://');
    expect(version).toMatch(/^system-v1-[0-9a-f]{10}$/);
    expect(loadSharedSystemPrompt()).toBe(loadSharedSystemPrompt());
  });
});

describe('ROLE_PROMPT', () => {
  it('states the rules every AI feature shares', () => {
    expect(ROLE_PROMPT).toMatch(/Palestine/);
    expect(ROLE_PROMPT).toMatch(/USAID[^.]*1 July 2025/);
    expect(ROLE_PROMPT).toMatch(/legacy/);
    expect(ROLE_PROMPT).toMatch(/Modern Standard Arabic/);
    expect(ROLE_PROMPT).toMatch(/Never invent numbers/);
    expect(ROLE_PROMPT).toMatch(/structured output/);
    expect(ROLE_PROMPT).toMatch(/aggregates only/);
    expect(ROLE_PROMPT).toMatch(/phone numbers/);
  });
});
