import { Backoffs, UnrecoverableError, Worker as QueueWorker } from 'bullmq';
import type { Config } from '../config.js';
import { log } from '../log.js';
import {
  type NotificationJob,
  type Receipt,
  type StoredNotification,
  QUEUE_NAME,
} from '../queue.js';
import { deliver } from './http.js';

// Only HTTP policy belongs here. BullMQ owns delayed jobs, retries, locks and recovery.
export function createWorker(config: Config, name = QUEUE_NAME, send = deliver) {
  const worker = new QueueWorker<StoredNotification, Receipt>(
    name,
    async (job: NotificationJob) => {
      const stop = (reason: string): never => {
        throw new UnrecoverableError(JSON.stringify({ errorCode: reason, terminalReason: reason }));
      };
      if (Date.now() >= job.data.expiresAt) stop('expired');
      if (job.attemptsStarted > job.data.maxAttempts) stop('attempts_exhausted');
      const result: Receipt = await send(
        { ...job.data, id: job.id!, attempt_count: job.attemptsStarted },
        config,
      );
      log('delivery_attempt', {
        notificationId: job.id,
        attempt: job.attemptsStarted,
        httpStatus: result.httpStatus,
        errorCode: result.errorCode ?? undefined,
        durationMs: result.durationMs,
      });
      if (result.outcome === 'http_success') return result;
      if (result.outcome === 'permanent_error') {
        throw new UnrecoverableError(
          JSON.stringify({ ...result, terminalReason: 'non_retryable' }),
        );
      }
      if (job.attemptsStarted >= job.data.maxAttempts) {
        throw new UnrecoverableError(
          JSON.stringify({ ...result, terminalReason: 'attempts_exhausted' }),
        );
      }
      const base = await Backoffs.builtinStrategies.exponential!(
        job.data.retryBaseMs,
        1,
      )(job.attemptsStarted);
      const delay = Math.max(
        Math.min(Number(base), job.data.retryCapMs),
        result.retryDelayMs,
        result.retryNotBefore ? new Date(result.retryNotBefore).getTime() - Date.now() : 0,
      );
      result.nextAttemptAt = Date.now() + delay;
      if (result.nextAttemptAt >= job.data.expiresAt) {
        throw new UnrecoverableError(JSON.stringify({ ...result, terminalReason: 'expired' }));
      }
      throw new Error(JSON.stringify(result));
    },
    {
      connection: { url: config.redisUrl, maxRetriesPerRequest: null },
      concurrency: config.concurrency,
      lockDuration: config.lockMs,
      stalledInterval: config.stalledIntervalMs,
      maxStalledCount: 100,
      settings: {
        backoffStrategy: (_attempt, _type, error) => {
          try {
            const result = JSON.parse(error?.message ?? '{}') as Receipt;
            return Math.max(0, (result.nextAttemptAt ?? Date.now()) - Date.now());
          } catch {
            return 1000;
          }
        },
      },
    },
  );
  worker.on('error', () => log('worker_error'));
  worker.on('failed', (job) => log('job_failed', { notificationId: job?.id }));
  worker.on('stalled', (id) => log('job_stalled', { notificationId: id }));
  return worker;
}
