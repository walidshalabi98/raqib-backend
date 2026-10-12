import type * as z from 'zod/v4';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

type JsonSchema = Record<string, unknown>;

/** Most anyOf unions (mostly nullable fields) one answer schema may use; structured outputs limit union types. */
export const MAX_UNIONS = 8;

/**
 * Problems that would make a zod/v4 answer schema unsuitable for structured outputs
 * (output_config.format), checked on the JSON schema the AI client actually sends:
 * the root is an object; every object has additionalProperties false and lists all of its
 * properties as required (no optional properties); at most MAX_UNIONS anyOf unions.
 * Returns an empty array when the schema is fine.
 */
export function structuredOutputSchemaProblems(schema: z.ZodType): string[] {
  const problems: string[] = [];
  const root = zodOutputFormat(schema).schema as JsonSchema;
  if (root.type !== 'object') problems.push('root: must be an object');
  let unions = 0;

  const visit = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object') return;
    const s = node as JsonSchema;
    if (Array.isArray(s.anyOf)) {
      unions += 1;
      s.anyOf.forEach((variant, i) => visit(variant, `${path}.anyOf[${i}]`));
    }
    if (s.type === 'object') {
      if (s.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
      const properties = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
      for (const key of Object.keys(properties)) {
        if (!required.has(key)) problems.push(`${path}.${key}: must be required (use "" or null for unknown values)`);
        visit(properties[key], `${path}.${key}`);
      }
    }
    if (s.type === 'array') visit(s.items, `${path}[]`);
    if (s.$defs && typeof s.$defs === 'object') {
      for (const [name, def] of Object.entries(s.$defs as Record<string, unknown>)) visit(def, `$defs.${name}`);
    }
  };
  visit(root, 'root');
  if (unions > MAX_UNIONS) problems.push(`root: ${unions} anyOf unions (at most ${MAX_UNIONS})`);
  return problems;
}
