import IORedis from 'ioredis';
import { env } from './env';
import { createRedisErrorLogger, redisUrlPassword } from './redisErrors';

const password = redisUrlPassword(env.redisUrl);

/** 'error' listener for a Redis client, queue or worker: name and message only, never the password. */
export const redisErrorHandler = createRedisErrorLogger({ secrets: password ? [password] : [] });

export const redis = new IORedis(env.redisUrl, {
  maxRetriesPerRequest: null,
});
redis.on('error', redisErrorHandler('connection'));
