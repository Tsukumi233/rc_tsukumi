import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../src/config.js';
import { Repository } from '../src/queue.js';

export const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:56379';
export function configFor(origin = 'http://127.0.0.1:4000'): Config {
  return {
    redisUrl,
    port: 3000,
    allowPrivateTargets: true,
    callers: [
      { id: 'demo', token: 'demo-token-change-me', allowedOrigins: [origin] },
      { id: 'other', token: 'other-token-change-me', allowedOrigins: [origin] },
    ],
    httpTimeoutMs: 100,
    lockMs: 500,
    stalledIntervalMs: 100,
    concurrency: 3,
    maxAttempts: 4,
    ttlMs: 60000,
    retryBaseMs: 1,
    retryCapMs: 1,
  };
}
export async function testQueue() {
  const repo = new Repository(redisUrl, `test-${randomUUID()}`);
  await repo.ready();
  return {
    repo,
    async reset() {
      await repo.queue.obliterate({ force: true });
    },
    async close() {
      await repo.queue.obliterate({ force: true });
      await repo.close();
    },
  };
}
export async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  timeout = 10000,
): Promise<T> {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (check(value)) return value;
    await sleep(20);
  } while (Date.now() < end);
  throw new Error('Condition not reached before timeout');
}
