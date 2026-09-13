import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker as QueueWorker } from 'bullmq';
import { normalizeRequest } from '../src/api/contracts.js';
import { createWorker } from '../src/worker/worker.js';
import { deliver } from '../src/worker/http.js';
import { Repository, type Receipt, type StoredNotification } from '../src/queue.js';
import { createMockProvider } from '../scripts/provider.js';
import { configFor, testQueue, eventually } from './helpers.js';

describe('BullMQ worker integration', () => {
  let db: Awaited<ReturnType<typeof testQueue>>;
  const provider = createMockProvider();
  let config = configFor();
  let workers: ReturnType<typeof createWorker>[] = [];
  const start = (send = deliver) => {
    const worker = createWorker(config, db.repo.name, send);
    workers.push(worker);
    return worker;
  };
  const accept = async (path = '/success', extra = {}) => {
    const key = randomUUID();
    const { envelope, hash } = normalizeRequest({
      url: `${config.callers[0]!.allowedOrigins[0]}${path}`,
      method: 'POST',
      headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
      body: '{"x":1}',
    });
    return (await db.repo.accept('demo', key, envelope, hash, { ...config, ...extra }))
      .notification;
  };
  const terminal = (id: string) =>
    eventually(
      () => db.repo.get(id, 'demo'),
      (r) => !!r && ['dead', 'succeeded'].includes(r.status),
    );
  beforeAll(async () => {
    db = await testQueue();
    provider.server.listen(0, '127.0.0.1');
    await once(provider.server, 'listening');
    const address = provider.server.address() as { port: number };
    config = configFor(`http://127.0.0.1:${address.port}`);
  });
  beforeEach(async () => {
    await db.reset();
  });
  afterEach(async () => {
    await Promise.all(workers.map((w) => w.close()));
    workers = [];
  });
  afterAll(async () => {
    provider.server.closeAllConnections();
    await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    await db.close();
  });

  it('sends the stored HTTP snapshot and records successful completion', async () => {
    const row = await accept();
    start();
    expect(await terminal(row.id)).toMatchObject({
      status: 'succeeded',
      attemptCount: 1,
      lastHttpStatus: 204,
    });
    expect(provider.received.at(-1)).toMatchObject({ method: 'POST', body: '{"x":1}' });
  });
  it('retains completed jobs so replay does not reset the budget or resend HTTP', async () => {
    const row = await accept();
    start();
    await terminal(row.id);
    const stored = (await db.repo.queue.getJob(row.id))!.data;
    const replay = await db.repo.accept(
      'demo',
      stored.idempotency_key,
      stored,
      stored.request_hash,
      config,
    );
    expect(replay).toMatchObject({
      created: false,
      notification: { id: row.id, status: 'succeeded', attemptCount: 1 },
    });
    expect(await db.repo.queue.getWaitingCount()).toBe(0);
  });
  it('uses automatic retries for transient failures and survives client reconnection', async () => {
    const row = await accept('/flaky');
    start();
    expect(await terminal(row.id)).toMatchObject({ status: 'succeeded', attemptCount: 3 });
    const reopened = new Repository(config.redisUrl, db.repo.name);
    try {
      await reopened.ready();
      expect((await reopened.get(row.id, 'demo'))?.status).toBe('succeeded');
    } finally {
      await reopened.close();
    }
  });
  it.each(['/permanent', '/redirect'])(
    'stops on %s without retrying or following redirects',
    async (path) => {
      const count = provider.received.length;
      const row = await accept(path);
      start();
      expect(await terminal(row.id)).toMatchObject({
        status: 'dead',
        attemptCount: 1,
        terminalReason: 'non_retryable',
      });
      expect(provider.received.length - count).toBe(1);
    },
  );
  it('bounds hung HTTP requests and stops at the attempt budget', async () => {
    const row = await accept('/timeout', { maxAttempts: 2 });
    start();
    expect(await terminal(row.id)).toMatchObject({
      status: 'dead',
      attemptCount: 2,
      lastErrorCode: 'timeout',
      terminalReason: 'attempts_exhausted',
    });
  });
  it('does not wait for an unbounded response body after 2xx headers', async () => {
    const row = await accept('/stream');
    start();
    expect(await terminal(row.id)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
  });
  it('honors Retry-After even when it exceeds the normal retry cap', async () => {
    const row = await accept('/rate-limit');
    const began = Date.now();
    start();
    const pending = await eventually(
      () => db.repo.get(row.id, 'demo'),
      (r) => r?.status === 'pending' && r.lastHttpStatus === 429,
    );
    expect(new Date(pending!.nextAttemptAt!).getTime()).toBeGreaterThanOrEqual(began + 1000);
    expect(await terminal(row.id)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    expect(Date.now() - began).toBeGreaterThanOrEqual(1000);
  });
  it('expires before sending when the worker starts after the deadline', async () => {
    const count = provider.received.length;
    const row = await accept('/success', { ttlMs: 10 });
    await sleep(20);
    start();
    expect(await terminal(row.id)).toMatchObject({ status: 'dead', terminalReason: 'expired' });
    expect(provider.received.length).toBe(count);
  });
  it('terminates when Retry-After is beyond the deadline', async () => {
    const row = await accept('/rate-limit', { ttlMs: 500 });
    start();
    expect(await terminal(row.id)).toMatchObject({
      status: 'dead',
      attemptCount: 1,
      terminalReason: 'expired',
    });
  });
  it('allows a duplicate HTTP delivery after a lost response while upstream deduplicates effects', async () => {
    const count = provider.effects.size;
    const row = await accept('/dedupe-drop');
    start();
    expect(await terminal(row.id)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    expect(provider.effects.size - count).toBe(1);
  });
  it('enforces local concurrency and avoids duplicate claims across two workers', async () => {
    const rows = await Promise.all(Array.from({ length: 12 }, () => accept()));
    const seen = new Set<string>();
    let active = 0,
      peak = 0;
    const send: typeof deliver = async (task, cfg) => {
      expect(seen.has(task.id)).toBe(false);
      seen.add(task.id);
      peak = Math.max(peak, ++active);
      await sleep(30);
      try {
        return await deliver(task, cfg);
      } finally {
        active--;
      }
    };
    start(send);
    start(send);
    await Promise.all(rows.map((r) => terminal(r.id)));
    expect(seen.size).toBe(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(config.concurrency * 2);
  });
  it('rejects completion with an expired token after another worker recovers the job', async () => {
    const row = await accept();
    const manual = new QueueWorker<StoredNotification, Receipt>(db.repo.name, undefined, {
      connection: { url: config.redisUrl },
      autorun: false,
      lockDuration: 100,
    });
    try {
      const old = await manual.getNextJob('old-worker-token');
      expect(old?.id).toBe(row.id);
      await sleep(150);
      start();
      expect(await terminal(row.id)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
      await expect(
        old!.moveToCompleted({} as Receipt, 'old-worker-token', false),
      ).rejects.toThrow();
      expect((await db.repo.get(row.id, 'demo'))?.lastHttpStatus).toBe(204);
    } finally {
      await manual.close();
    }
  });
  it('does not send another HTTP request when a crashed claim consumed the last allowance', async () => {
    const row = await accept('/success', { maxAttempts: 1 });
    const count = provider.received.length;
    const manual = new QueueWorker<StoredNotification, Receipt>(db.repo.name, undefined, {
      connection: { url: config.redisUrl },
      autorun: false,
      lockDuration: 100,
    });
    try {
      await manual.getNextJob('crashed-token');
      await sleep(150);
      start();
      expect(await terminal(row.id)).toMatchObject({
        status: 'dead',
        terminalReason: 'attempts_exhausted',
        attemptCount: 1,
      });
      expect(provider.received.length).toBe(count);
    } finally {
      await manual.close();
    }
  });
  it.each(['before_http', 'after_http'])(
    'recovers after real SIGKILL at %s',
    async (checkpoint) => {
      const row = await accept();
      const child = fork(new URL('./fixtures/claim.ts', import.meta.url), [], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          ...process.env,
          TEST_QUEUE: db.repo.name,
          TEST_CONFIG: JSON.stringify(config),
          CHECKPOINT: checkpoint,
        },
      });
      try {
        await Promise.race([
          once(child, 'message'),
          sleep(5000).then(() => {
            throw new Error('Child checkpoint timeout');
          }),
        ]);
        const exit = once(child, 'exit');
        child.kill('SIGKILL');
        await exit;
        start();
        expect(await terminal(row.id)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    },
  );
});
