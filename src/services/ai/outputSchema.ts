/**
 * The JSON schema sent as output_config.format (structured outputs) for a zod/v4 answer
 * schema. Pure; used by client.ts and by the tests that check every answer schema
 * (tests/aiSchemaHelpers.ts). It imports only the SDK's schema transform, never the client:
 * model calls still go through client.ts alone (CLAUDE.md rule 4).
 */
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import { toJSONSchema } from 'zod/v4';
import type * as z from 'zod/v4';

type JsonNode = Record<string, unknown>;
/** enum / const values lifted out of a JSON schema node, keyed by the node's path. */
type Constraints = Map<string, { enum?: unknown; const?: unknown }>;

/**
 * The JSON schema sent as output_config.format for a zod/v4 answer schema.
 *
 * Built like the SDK's zodOutputFormat (z.toJSONSchema, then the SDK's strict-schema
 * transform: additionalProperties false, unsupported keywords moved into descriptions),
 * except that `enum` and `const` stay in the schema. Structured outputs enforce both, but the
 * SDK transform (0.133) moves them into the description, so the model would only be told the
 * allowed values and one value off the list would fail a whole call at the zod check.
 * The `$schema` marker is dropped (it only ended up in the root description).
 */
export function outputJsonSchema(schema: z.ZodType): JsonNode {
  const source = toJSONSchema(schema, { reused: 'ref' }) as JsonNode;
  delete source.$schema;
  const lifted: Constraints = new Map();
  liftConstraints(source, '#', lifted);
  const strict = transformJSONSchema(source) as JsonNode;
  restoreConstraints(strict, '#', lifted);
  return strict;
}

/** Child schema nodes with a path segment that survives the SDK transform (oneOf becomes anyOf). */
function childNodes(node: JsonNode): Array<[string, unknown]> {
  const children: Array<[string, unknown]> = [];
  const add = (key: string, value: unknown) => {
    if (value && typeof value === 'object') children.push([key, value]);
  };
  for (const [name, child] of Object.entries((node.properties ?? {}) as JsonNode)) add(`properties/${name}`, child);
  for (const [name, child] of Object.entries((node.$defs ?? {}) as JsonNode)) add(`$defs/${name}`, child);
  if (!Array.isArray(node.items)) add('items', node.items);
  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null;
  union?.forEach((child, i) => add(`anyOf/${i}`, child));
  if (Array.isArray(node.allOf)) node.allOf.forEach((child, i) => add(`allOf/${i}`, child));
  return children;
}

function liftConstraints(node: JsonNode, path: string, lifted: Constraints): void {
  const kept: { enum?: unknown; const?: unknown } = {};
  if ('enum' in node) {
    kept.enum = node.enum;
    delete node.enum;
  }
  if ('const' in node) {
    kept.const = node.const;
    delete node.const;
  }
  if ('enum' in kept || 'const' in kept) lifted.set(path, kept);
  for (const [key, child] of childNodes(node)) liftConstraints(child as JsonNode, `${path}/${key}`, lifted);
}

function restoreConstraints(node: JsonNode, path: string, lifted: Constraints): void {
  const kept = lifted.get(path);
  if (kept) Object.assign(node, kept);
  for (const [key, child] of childNodes(node)) restoreConstraints(child as JsonNode, `${path}/${key}`, lifted);
}
