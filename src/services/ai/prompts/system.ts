/**
 * The shared system prompt sent first on every AI call (BUILD_GUIDE Phase 3 task 3):
 * a role paragraph plus sections 1–12 of knowledge/me-foundations.md. The AI client
 * (src/services/ai/client.ts) adds it with prompt caching; services send only their
 * feature-specific instructions.
 *
 * The file is read once and cached. Call loadSharedSystemPrompt() at startup so a
 * missing or broken knowledge file stops the API and the worker with a clear message.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import nodePath from 'path';

export const SYSTEM_PROMPT_VERSION = 'system-v1';

/** M&E rules loaded into the system prompt (CLAUDE.md "Read first"). */
export const DEFAULT_FOUNDATIONS_PATH = nodePath.resolve(__dirname, '../../../../knowledge/me-foundations.md');

/** Sections of me-foundations.md the models receive; §13 (sources) and later are for people. */
export const FOUNDATION_SECTIONS = Array.from({ length: 12 }, (_, i) => i + 1);

export const ROLE_PROMPT = `You are Raqib's monitoring and evaluation (M&E) specialist for development and humanitarian projects in Palestine and the wider region. Your users are NGOs, INGOs and consultancies who design results frameworks, track indicators and report to donors.

You know:
- Results frameworks and logframes (goal, outcomes, outputs, activities) and SMART indicators.
- The donor landscape: EU (Global Europe Results Framework) and DG ECHO, GIZ, UNDP, UNICEF, WFP, UNFPA, UN Women, FCDO, Sida, the humanitarian clusters and pooled funds. USAID stopped administering awards on 1 July 2025; treat it as a legacy donor whose formats appear only in older projects.
- Sector standards: Sphere, WFP food security indicators, JMP, the IASC MHPSS framework, the Core Humanitarian Standard and the Washington Group questions.
- Data collection in the Palestinian context, including movement restrictions and remote methods.

How you answer:
- Return only the structured output requested, in the exact format given. The server validates every answer.
- Write English for English fields and Modern Standard Arabic for Arabic fields, suitable for donor and ministry readers.
- Never invent numbers. Baselines, targets and statistics come only from the documents or figures you are given, or from a recognised standard you can name; otherwise say the value is to be confirmed and suggest how to set it.
- You receive aggregates only. Never ask for, repeat or produce personal data: names, ID numbers, phone numbers, email addresses or exact addresses.
- Follow the M&E rules below. When a donor's own guidance is given for a project, it overrides the general rules.`;

/**
 * @deprecated Kept until the last services move to generateStructured; the AI client
 * already sends ROLE_PROMPT and the foundations, so new code must not send this again.
 */
export const SYSTEM_CONTEXT = ROLE_PROMPT;

export interface SharedSystemPrompt {
  /** ROLE_PROMPT followed by the foundations title and §1–12. */
  text: string;
  /** SYSTEM_PROMPT_VERSION plus a short hash of `text`; changes whenever the knowledge file changes. */
  version: string;
}

const cache = new Map<string, SharedSystemPrompt>();

/**
 * Builds the shared system prompt from the foundations file (default
 * knowledge/me-foundations.md). Keeps the document title and sections "## 1." to "## 12.";
 * drops the introduction (written for developers) and "## 13. Sources" onwards.
 * Throws a clear error when the file cannot be read or a section is missing.
 */
export function loadSharedSystemPrompt(path: string = DEFAULT_FOUNDATIONS_PATH): SharedSystemPrompt {
  const cached = cache.get(path);
  if (cached) return cached;

  let markdown: string;
  try {
    markdown = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read the M&E foundations file for the AI system prompt (${path}): ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }

  const foundations = extractFoundations(markdown, path);
  const text = `${ROLE_PROMPT}\n\n${foundations}`;
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 10);
  const result: SharedSystemPrompt = { text, version: `${SYSTEM_PROMPT_VERSION}-${hash}` };
  cache.set(path, result);
  return result;
}

/** Clears the cache (tests, or after editing the knowledge file in a running dev process). */
export function clearSharedSystemPromptCache(): void {
  cache.clear();
}

function extractFoundations(markdown: string, path: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const title = lines.find(line => /^# \S/.test(line));
  if (!title) throw new Error(`The M&E foundations file has no "# " title (${path}).`);

  const sectionStart = (n: number) => lines.findIndex(line => line.startsWith(`## ${n}. `));
  const missing = FOUNDATION_SECTIONS.filter(n => sectionStart(n) === -1);
  if (missing.length) {
    throw new Error(`The M&E foundations file is missing section(s) ${missing.map(n => `"## ${n}."`).join(', ')} needed for the AI system prompt (${path}).`);
  }

  const start = sectionStart(FOUNDATION_SECTIONS[0]);
  const last = sectionStart(FOUNDATION_SECTIONS[FOUNDATION_SECTIONS.length - 1]);
  // The prompt ends at the next top-level section after §12 (normally "## 13. Sources").
  const nextSection = lines.findIndex((line, i) => i > last && /^## /.test(line));
  const body = lines.slice(start, nextSection === -1 ? lines.length : nextSection);
  // A trailing horizontal rule or blank lines belong to the dropped part.
  while (body.length && /^(\s*|-{3,})$/.test(body[body.length - 1])) body.pop();

  return `${title}\n\n${body.join('\n')}`;
}
