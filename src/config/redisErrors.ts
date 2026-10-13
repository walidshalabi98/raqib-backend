/**
 * Redis errors without secrets (SECURITY_SETUP §3: no secrets in logs).
 *
 * ioredis attaches the failed command to its errors, and for HELLO and AUTH that command holds
 * the Redis password. Printing the error object (ioredis' "Unhandled error event", BullMQ's
 * fallback for a queue or worker without an 'error' listener) writes the password to the logs.
 * Every Redis client, queue and worker therefore gets a listener that logs only the error's name
 * and the first line of its message, with credentials removed, at most once a minute per message.
 */

const CREDENTIALS_IN_URL = /(rediss?:\/\/)[^@\s/]*@/gi;
const MAX_MESSAGE_LENGTH = 200;
const MAX_TRACKED_MESSAGES = 50;
export const REDIS_ERROR_LOG_INTERVAL_MS = 60_000;

/** The password inside a redis:// URL, so it can be removed from messages too. */
export function redisUrlPassword(url: string): string | undefined {
  try {
    const password = decodeURIComponent(new URL(url).password);
    return password || undefined;
  } catch {
    return undefined;
  }
}

/** "Name: first line of the message", without credentials or the command the error carries. */
export function describeRedisError(err: unknown, secrets: readonly string[] = []): string {
  if (!(err instanceof Error)) return 'Unknown Redis error';
  const name = err.name || 'Error';
  let message = String(err.message ?? '').split('\n', 1)[0].replace(CREDENTIALS_IN_URL, '$1***@');
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('***');
  }
  message = message.trim().slice(0, MAX_MESSAGE_LENGTH);
  return message ? `${name}: ${message}` : name;
}

export interface RedisErrorLoggerOptions {
  secrets?: readonly string[];
  log?: (line: string) => void;
  now?: () => number;
  intervalMs?: number;
}

/**
 * Returns `handlerFor(source)`: an 'error' listener for one client, queue or worker. The
 * listeners share one throttle, so an outage seen by every connection is reported once a minute,
 * with the number of repeats in between.
 */
export function createRedisErrorLogger(options: RedisErrorLoggerOptions = {}) {
  const {
    secrets = [],
    log = (line: string) => console.error(line),
    now = Date.now,
    intervalMs = REDIS_ERROR_LOG_INTERVAL_MS,
  } = options;
  const seen = new Map<string, { at: number; repeats: number }>();

  return function handlerFor(source: string) {
    return (err: unknown): void => {
      const summary = describeRedisError(err, secrets);
      const time = now();
      const last = seen.get(summary);
      if (last && time - last.at < intervalMs) {
        last.repeats += 1;
        return;
      }
      if (!last && seen.size >= MAX_TRACKED_MESSAGES) seen.clear();
      const repeats = last?.repeats ? ` (repeated ${last.repeats} times since the last report)` : '';
      seen.set(summary, { at: time, repeats: 0 });
      log(`[Redis] ${source}: ${summary}${repeats}`);
    };
  };
}
