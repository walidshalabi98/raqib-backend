import { Prisma } from '@prisma/client';

/** The result an indicator measures, as returned with every indicator: { id, code, level, text }. */
export const RESULT_SUMMARY_SELECT = {
  id: true,
  code: true,
  level: true,
  text: true,
} satisfies Prisma.ResultNodeSelect;

/** Include for a single indicator response. */
export const INDICATOR_INCLUDE = {
  result: { select: RESULT_SUMMARY_SELECT },
} satisfies Prisma.IndicatorInclude;

/**
 * Include for indicator lists (framework views): the result plus the number of data points the caller can see
 * (`dataPointWhere`: donorDataPointWhere(req.user), so donor viewers never count KoboToolbox rows).
 */
export function indicatorListInclude(dataPointWhere: Prisma.DataPointWhereInput) {
  return {
    ...INDICATOR_INCLUDE,
    _count: { select: { dataPoints: { where: dataPointWhere } } },
  } satisfies Prisma.IndicatorInclude;
}

/** Include for result nodes: how many indicators and child results each has. */
export const RESULT_NODE_INCLUDE = {
  _count: { select: { indicators: true, children: true } },
} satisfies Prisma.ResultNodeInclude;
