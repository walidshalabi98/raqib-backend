import IORedis from 'ioredis';
import { env } from './env';

export const redis = new IORedis(env.redisUrl, {
  maxRetriesPerRequest: null,
});
