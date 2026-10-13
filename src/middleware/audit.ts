import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { safeErrorSummary } from '../services/ai/errors';

export async function auditLog(
  userId: string,
  action: string,
  entity: string,
  entityId: string,
  previousValue?: unknown,
  newValue?: unknown,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId,
      action,
      entity,
      entityId,
      previousValue: previousValue ? JSON.parse(JSON.stringify(previousValue)) : undefined,
      newValue: newValue ? JSON.parse(JSON.stringify(newValue)) : undefined,
    },
  });
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** A field name as the API defines them (camelCase or snake_case); anything else is not recorded. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_FIELDS = 50;

/**
 * The names of the top-level fields a request body sent (sorted), never their values: which fields a write
 * touched (for example `targetValue` on an indicator). Only names that look like API field names are kept,
 * at most 50, so a body whose keys are data (a name typed as a key) is not copied into the log.
 */
export function bodyFieldNames(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.keys(body).filter(key => FIELD_NAME.test(key)).sort().slice(0, MAX_FIELDS);
}

const INDICATOR_VALUES = [
  'id', 'indicatorText', 'indicatorTextAr', 'level', 'unit', 'status', 'direction', 'isApproved',
  'baselineValue', 'baselineDate', 'baselineMethod', 'targetValue', 'targetJustification', 'intermediateTargets',
  'currentValue', 'startDate', 'endDate', 'actualStartDate', 'actualEndDate',
] as const;
const RESULT_VALUES = ['id', 'code', 'level', 'text', 'textAr', 'parentId'] as const;
const PROJECT_VALUES = [
  'id', 'name', 'nameAr', 'status', 'sector', 'sectors', 'donor', 'donorType', 'budgetUsd', 'startDate', 'endDate',
  'targetBeneficiaries',
] as const;
const FRAMEWORK_VALUES = ['id', 'version', 'status', 'name', 'approvedAt', 'approvedBy'] as const;
/** A result staff entered: never notes, area, attachments or source text. */
const DATA_POINT_VALUES = ['id', 'indicatorId', 'assessmentId', 'value', 'collectionDate', 'collectionMethod'] as const;
/**
 * Publishing to donors: which report (id, type, period and the generation it was published from), and its new
 * status. Never the narrative, the file location or the free-text title. The audit row is the record of who
 * published or withdrew a report, and when.
 */
const REPORT_VALUES = ['id', 'projectId', 'type', 'status', 'generatedAt', 'periodStart', 'periodEnd'] as const;

/**
 * Writes whose audit row also keeps values (`newValue.values`), so the history of an M&E record (who set a
 * baseline, target or current value, when, and to what) can be read back. Keyed by "METHOD route path" as the
 * route is registered; the values are the listed fields of the record the route answered with, after it was
 * saved. Every field listed is about the project's results or reports, never about a person. Every other
 * write (beneficiaries, services, qualitative entries, documents, users, organisations, webhook tokens) keeps
 * field names only. tests/audit.test.ts checks that every key names a registered route.
 */
export const AUDIT_VALUE_ROUTES: Readonly<Record<string, readonly string[]>> = {
  'POST /api/projects/': PROJECT_VALUES,
  'PATCH /api/projects/:id': PROJECT_VALUES,
  'POST /api/projects/:id/framework/manual': FRAMEWORK_VALUES,
  'PATCH /api/frameworks/:id/approve': FRAMEWORK_VALUES,
  'POST /api/frameworks/:id/results': RESULT_VALUES,
  'PATCH /api/results/:id': RESULT_VALUES,
  'POST /api/frameworks/:id/indicators': INDICATOR_VALUES,
  'PATCH /api/indicators/:id': INDICATOR_VALUES,
  'PATCH /api/indicators/:id/approve': INDICATOR_VALUES,
  'POST /api/indicators/:id/data': DATA_POINT_VALUES,
  'PATCH /api/reports/:id/publish': REPORT_VALUES,
  'PATCH /api/reports/:id/unpublish': REPORT_VALUES,
};

/** The allow-listed fields of a response body (a plain object), or null when there are none. */
export function auditValues(fields: readonly string[], body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) values[field] = (body as Record<string, unknown>)[field];
  }
  return Object.keys(values).length > 0 ? values : null;
}

/**
 * One AuditLog row per write request by a signed-in user, with who, what (method and path), when, the HTTP
 * status and the names of the fields the body sent (`newValue = { status, fields }`), so refused requests (403)
 * are told apart from successes and a change of, say, an indicator's target can be traced to who and when.
 * Successful writes to project, framework, result, indicator and data point records, and publishing or
 * withdrawing a report, also keep the allow-listed values of the saved record (`values`, AUDIT_VALUE_ROUTES), so
 * the history of a baseline or target, and of what was shared with donors, can be read back. Never any other
 * value from the request or response body: bodies hold beneficiaries' personal
 * data and new webhook tokens (CLAUDE.md rules 3 and 5). Written when the response finishes, so uploads,
 * multer refusals and error-handler answers are covered. Requests without a signed-in user (401s, sign-in,
 * webhooks) are not attributed and not written.
 */
export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (WRITE_METHODS.has(req.method)) {
    let values: Record<string, unknown> | null = null;
    // The route is known while it answers (req.route and req.baseUrl may be reset once the response is done).
    const json = res.json.bind(res);
    res.json = function auditedJson(body?: unknown) {
      const fields = req.route?.path ? AUDIT_VALUE_ROUTES[`${req.method} ${req.baseUrl}${req.route.path}`] : undefined;
      if (fields && res.statusCode >= 200 && res.statusCode < 300) values = auditValues(fields, body);
      return json(body);
    } as Response['json'];
    let written = false;
    const write = () => {
      if (written) return;
      written = true;
      // req.user is set by route-level authenticate, after this middleware runs.
      if (!req.user) return;
      const path = req.originalUrl.split('?')[0];
      const entity = path.replace(/^\/api\/?/, '').split('/')[0] || 'unknown';
      // req.params is the route's after a route answered; after an error it may be reset, so fall back to the path.
      const entityId = req.params?.id || path.match(UUID_PATTERN)?.[0] || 'N/A';
      const fields = bodyFieldNames(req.body);
      const newValue = {
        status: res.statusCode,
        fields,
        ...(values && { values }),
        ...(!res.writableFinished && { aborted: true }),
      };
      auditLog(req.user.id, `${req.method} ${path}`, entity, entityId, undefined, newValue).catch(err => {
        console.error(`[Audit] Could not write the audit row for ${req.method} ${entity}: ${safeErrorSummary(err)}`);
      });
    };
    res.once('finish', write);
    // A client that disconnects first: the write may still have happened, so it is recorded as aborted.
    res.once('close', write);
  }
  next();
}
