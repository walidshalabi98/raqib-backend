import { Queue } from 'bullmq';
import { redis } from '../config/redis';

let documentParsingQueue: Queue;
let frameworkQueue: Queue;
let indicatorQueue: Queue;
let reportQueue: Queue;
let qualitativeQueue: Queue;

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

export function getIndicatorQueue(): Queue {
  if (!indicatorQueue) {
    indicatorQueue = new Queue('indicator-alternatives', { connection: redis });
  }
  return indicatorQueue;
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
