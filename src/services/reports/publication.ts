import { Language, NotificationType, Report } from '@prisma/client';

/**
 * Publishing reports to donor viewers (docs/SECURITY_SETUP.md §8.3). Org admins and platform admins publish a
 * finished report after reviewing it; donor viewers see published reports only. Pure functions, unit tested in
 * tests/reportPublishing.test.ts; the routes are in src/routes/reports.ts.
 */

const hasText = (value: string | null | undefined): boolean => typeof value === 'string' && value.trim().length > 0;

/**
 * A finished report: its file or its narrative exists. Report generation stores the narrative only when it
 * succeeds, so a report that is still being generated, or whose generation failed, is not finished.
 */
export function isFinishedReport(report: Pick<Report, 'fileUrl' | 'aiNarrative'>): boolean {
  return hasText(report.fileUrl) || hasText(report.aiNarrative);
}

/** The 409 answer to publishing a report that is not finished. */
export const UNFINISHED_REPORT_MESSAGE =
  'Only a finished report can be published: this report has no narrative or file yet (it is still being generated, or generation failed)';

/**
 * Donor viewers are told when a report becomes readable for them. `report_generated` is the existing
 * "a report is ready" type (no schema change).
 */
export const REPORT_PUBLISHED_NOTIFICATION: NotificationType = 'report_generated';

export interface ReportNotificationContent {
  type: NotificationType;
  title: string;
  message: string;
  link: string;
}

/**
 * The notification a donor viewer gets when a report is published, in the viewer's language (Modern Standard
 * Arabic for `ar`, English otherwise). Holds only what the donor can read once the report is published: the
 * report title and the project name.
 */
export function reportPublishedNotification(
  report: Pick<Report, 'projectId' | 'title'>,
  project: { name: string; nameAr?: string | null },
  language: Language | string | null | undefined,
): ReportNotificationContent {
  // The project page opens on its Reports tab, where donor viewers read the report (frontend ProjectDetail).
  const link = `/projects/${report.projectId}?tab=reports`;
  if (language === 'ar') {
    const projectName = hasText(project.nameAr) ? project.nameAr!.trim() : project.name;
    return {
      type: REPORT_PUBLISHED_NOTIFICATION,
      title: `نُشر تقرير: ${report.title}`,
      message: `أصبح تقرير «${report.title}» الخاص بمشروع ${projectName} متاحاً للاطلاع.`,
      link,
    };
  }
  return {
    type: REPORT_PUBLISHED_NOTIFICATION,
    title: `Report published: ${report.title}`,
    message: `"${report.title}" for ${project.name} is ready to read.`,
    link,
  };
}
