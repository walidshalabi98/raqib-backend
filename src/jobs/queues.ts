import { Queue } from 'bullmq';
import { redis } from '../config/redis';
import { MAINTENANCE_QUEUE } from '../services/maintenance/aiCallRetention';

let documentParsingQueue: Queue;
let frameworkQueue: Queue;
let reportQueue: Queue;
let qualitativeQueue: Queue;
let maintenanceQueue: Queue;

export function getDocumentParsingQueue(): Queue {
  if (!documentParsingQueue) {
    documentParsingQueue = new Queue('document-parsing', { connection: redis });
  }
  return documentParsingQueue;
}

export function getFrameworkQueue(): Queue {
  if (!frameworkQueue) {
    frameworkQueue = new Queue('framework-generation', { connection: redis });
  }
  return frameworkQueue;
}

export function getReportQueue(): Queue {
  if (!reportQueue) {
    reportQueue = new Queue('report-generation', { connection: redis });
  }
  return reportQueue;
}

export function getQualitativeQueue(): Queue {
  if (!qualitativeQueue) {
    qualitativeQueue = new Queue('qualitative-coding', { connection: redis });
  }
  return qualitativeQueue;
}

/** Scheduled housekeeping jobs (the nightly 'prune-ai-calls'); the worker registers the schedule. */
export function getMaintenanceQueue(): Queue {
  if (!maintenanceQueue) {
    maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection: redis });
  }
  return maintenanceQueue;
}
