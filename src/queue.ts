import { createHash, randomUUID } from 'node:crypto';
import { Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import pTimeout from 'p-timeout';
import type { Config } from './config.js';
import type { DeliveryResult, Envelope, Status } from './domain.js';
import { RequestError } from './errors.js';
import { log } from './log.js';

export const QUEUE_NAME = 'http-notifications';
export interface StoredNotification extends Envelope {
  caller_id: string;
  idempotency_key: string;
  request_hash: string;
  acceptance: string;
  expiresAt: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryCapMs: number;
}
export interface Receipt extends DeliveryResult {
  terminalReason?: string;
  nextAttemptAt?: number;
}
export type NotificationJob = Job<StoredNotification, Receipt>;

// A UUID-shaped, caller-scoped job ID lets BullMQ's atomic add script own deduplication.
export function notificationId(caller: string, key: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify([caller, key]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class Repository {
  readonly client: Redis;
  readonly queue: Queue<StoredNotification, Receipt>;
  constructor(
    redisUrl: string,
    readonly name = QUEUE_NAME,
  ) {
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      commandTimeout: 3000,
    });
    this.client.on('error', () => log('queue_connection_error'));
    this.queue = new Queue<StoredNotification, Receipt>(name, { connection: this.client });
    this.queue.on('error', () => log('queue_error'));
  }

  async ready(): Promise<void> {
    await pTimeout(this.queue.waitUntilReady(), { milliseconds: 2000 });
    const settings = await this.client.config(
      'GET',
      'appendonly',
      'appendfsync',
      'maxmemory-policy',
      'no-appendfsync-on-rewrite',
    );
    const config = new Map<string, string>();
    for (let i = 0; i < settings.length; i += 2) config.set(settings[i]!, settings[i + 1]!);
    if (
      config.get('appendonly') !== 'yes' ||
      config.get('appendfsync') !== 'always' ||
      config.get('maxmemory-policy') !== 'noeviction' ||
      config.get('no-appendfsync-on-rewrite') !== 'no'
    )
      throw new Error('Redis durability configuration does not match the acceptance contract');
    const info = await this.client.info('persistence');
    if (!info.includes('aof_last_write_status:ok')) throw new Error('AOF persistence unavailable');
  }

  async accept(callerId: string, key: string, envelope: Envelope, hash: string, config: Config) {
    if (this.client.status !== 'ready') throw new Error('Storage unavailable');
    const id = notificationId(callerId, key);
    const acceptance = randomUUID();
    await this.queue.add(
      'deliver',
      {
        ...envelope,
        caller_id: callerId,
        idempotency_key: key,
        request_hash: hash,
        acceptance,
        expiresAt: Date.now() + config.ttlMs,
        maxAttempts: config.maxAttempts,
        retryBaseMs: config.retryBaseMs,
        retryCapMs: config.retryCapMs,
      },
      {
        jobId: id,
        attempts: config.maxAttempts,
        backoff: { type: 'http' },
        removeOnComplete: false,
        removeOnFail: false,
        stackTraceLimit: 0,
      },
    );
    // add() may have found an existing ID; only the stored snapshot is authoritative.
    const job = await this.queue.getJob(id);
    if (!job) throw new Error('Accepted job unavailable');
    if (
      job.data.request_hash !== hash ||
      job.data.caller_id !== callerId ||
      job.data.idempotency_key !== key
    )
      throw new RequestError('idempotency_conflict', 409);
    return { created: job.data.acceptance === acceptance, notification: await this.view(job) };
  }

  async get(id: string, callerId: string) {
    const job = await this.queue.getJob(id);
    return job?.data.caller_id === callerId ? this.view(job) : undefined;
  }

  async view(initial: NotificationJob) {
    const state = await initial.getState();
    if (state === 'unknown') throw new Error('Job state unavailable');
    // Settlement can happen between reads. Refresh result fields after observing a terminal state.
    const job = ['completed', 'failed'].includes(state)
      ? (await this.queue.getJob(initial.id!))!
      : initial;
    let receipt: Partial<Receipt> = job.returnvalue ?? {};
    if (state !== 'completed' && job.failedReason) {
      try {
        receipt = JSON.parse(job.failedReason) as Receipt;
      } catch {
        receipt = { errorCode: 'worker_interrupted' };
      }
    }
    const status: Status =
      state === 'completed'
        ? 'succeeded'
        : state === 'failed'
          ? 'dead'
          : state === 'active'
            ? 'in_flight'
            : 'pending';
    return {
      id: job.id!,
      status,
      attemptCount: Math.min(job.attemptsStarted, job.data.maxAttempts),
      maxAttempts: job.data.maxAttempts,
      nextAttemptAt:
        status === 'pending'
          ? new Date(receipt.nextAttemptAt ?? job.timestamp).toISOString()
          : null,
      expiresAt: new Date(job.data.expiresAt).toISOString(),
      createdAt: new Date(job.timestamp).toISOString(),
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      lastHttpStatus: receipt.httpStatus ?? null,
      lastErrorCode: receipt.errorCode ?? null,
      terminalReason: status === 'dead' ? (receipt.terminalReason ?? 'worker_failed') : null,
    };
  }

  async close(): Promise<void> {
    this.client.disconnect();
    await this.queue.close();
  }
}
