import { z } from 'zod';

const callersSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        token: z.string().min(16).max(256),
        allowedOrigins: z.array(z.string().url()).min(1),
      })
      .strict(),
  )
  .min(1);

export type Caller = z.infer<typeof callersSchema>[number];
export interface Config {
  redisUrl: string;
  port: number;
  callers: Caller[];
  allowPrivateTargets: boolean;
  httpTimeoutMs: number;
  lockMs: number;
  stalledIntervalMs: number;
  concurrency: number;
  maxAttempts: number;
  ttlMs: number;
  retryBaseMs: number;
  retryCapMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const integer = (name: string, fallback: number, max = 2_147_483_647) => {
    const value = env[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || +value < 1 || +value > max)
      throw new Error(`Invalid configuration: ${name}`);
    return +value;
  };
  let callers: Caller[];
  try {
    callers = callersSchema.parse(JSON.parse(env.CALLERS_JSON ?? '[]'));
  } catch {
    throw new Error('Invalid configuration: CALLERS_JSON');
  }
  if (
    new Set(callers.map((c) => c.id)).size !== callers.length ||
    new Set(callers.map((c) => c.token)).size !== callers.length
  )
    throw new Error('Caller IDs and tokens must be unique');
  if (env.ALLOW_PRIVATE_TARGETS && !['true', 'false'].includes(env.ALLOW_PRIVATE_TARGETS)) {
    throw new Error('Invalid configuration: ALLOW_PRIVATE_TARGETS');
  }
  const allowPrivateTargets = env.ALLOW_PRIVATE_TARGETS === 'true';
  if (allowPrivateTargets && !['development', 'test'].includes(env.NODE_ENV ?? 'production')) {
    throw new Error('Private targets require explicit development or test mode');
  }
  for (const caller of callers)
    for (const origin of caller.allowedOrigins) {
      const url = new URL(origin);
      if (
        url.origin !== origin ||
        !['http:', 'https:'].includes(url.protocol) ||
        (!allowPrivateTargets && url.protocol !== 'https:')
      )
        throw new Error('Invalid allowed origin');
    }
  const redisUrl = env.REDIS_URL ?? '';
  try {
    if (!['redis:', 'rediss:'].includes(new URL(redisUrl).protocol)) throw new Error();
  } catch {
    throw new Error('Invalid configuration: REDIS_URL');
  }
  const config: Config = {
    redisUrl,
    callers,
    allowPrivateTargets,
    port: integer('PORT', 3000, 65535),
    httpTimeoutMs: integer('HTTP_TIMEOUT_MS', 10000),
    lockMs: integer('LOCK_MS', 30000),
    stalledIntervalMs: integer('STALLED_INTERVAL_MS', 30000),
    concurrency: integer('WORKER_CONCURRENCY', 10, 100),
    maxAttempts: integer('MAX_ATTEMPTS', 12, 100),
    ttlMs: integer('NOTIFICATION_TTL_MS', 86400000),
    retryBaseMs: integer('RETRY_BASE_MS', 30000),
    retryCapMs: integer('RETRY_CAP_MS', 3600000),
  };
  if (config.lockMs <= config.httpTimeoutMs) throw new Error('LOCK_MS must exceed HTTP_TIMEOUT_MS');
  if (config.retryCapMs < config.retryBaseMs)
    throw new Error('RETRY_CAP_MS must be at least RETRY_BASE_MS');
  return config;
}
