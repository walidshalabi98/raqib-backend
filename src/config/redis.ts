import IORedis from 'ioredis';
import { env } from './env';
import { createRedisErrorLogger, describeRedisError, redisUrlPassword } from './redisErrors';

const password = redisUrlPassword(env.redisUrl);
const secrets = password ? [password] : [];

/** 'error' listener for a Redis client, queue or worker: name and message only, never the password. */
export const redisErrorHandler = createRedisErrorLogger({ secrets });

function connect(): IORedis {
  try {
    return new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
  } catch (err) {
    // ioredis' URL errors carry the whole URL, password included: log the name and message only, then stop.
    console.error(`[Redis] connection: ${describeRedisError(err, secrets)}`);
    process.exit(1);
  }
}

export const redis = connect();
redis.on('error', redisErrorHandler('connection'));
