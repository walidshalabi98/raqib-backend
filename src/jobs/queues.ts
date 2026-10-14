import { Queue } from 'bullmq';
import { redis, redisErrorHandler } from '../config/redis';
import { MAINTENANCE_QUEUE } from '../services/maintenance/aiCallRetention';

/** Every queue logs connection errors without the password (config/redisErrors.ts). */
function createQueue(name: string): Queue {
  const queue = new Queue(name, { connection: redis });
  queue.on('error', redisErrorHandler(`queue ${name}`));
  return queue;
}

let documentParsingQueue: Queue;
let frameworkQueue: Queue;
let reportQueue: Queue;
let qualitativeQueue: Queue;
let maintenanceQueue: Queue;

export function getDocumentParsingQueue(): Queue {
  if (!documentParsingQueue) {
    documentParsingQueue = createQueue('document-parsing');
  }
  return documentParsingQueue;
}

export function getFrameworkQueue(): Queue {
  if (!frameworkQueue) {
    frameworkQueue = createQueue('framework-generation');
  }
  return frameworkQueue;
}

export function getReportQueue(): Queue {
  if (!reportQueue) {
    reportQueue = createQueue('report-generation');
  }
  return reportQueue;
}

export function getQualitativeQueue(): Queue {
  if (!qualitativeQueue) {
    qualitativeQueue = createQueue('qualitative-coding');
  }
  return qualitativeQueue;
}

/** Scheduled housekeeping jobs (the nightly 'prune-ai-calls'); the worker registers the schedule. */
export function getMaintenanceQueue(): Queue {
  if (!maintenanceQueue) {
    maintenanceQueue = createQueue(MAINTENANCE_QUEUE);
  }
  return maintenanceQueue;
}
