import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compose, eventually, project, saveDiagnostics } from './stack.js';

// No application, queue or Redis imports: assertions use public HTTP and the supplier's observations.
interface Notification {
  id: string;
  status: 'pending' | 'in_flight' | 'succeeded' | 'dead';
  attemptCount: number;
  maxAttempts: number;
  lastHttpStatus: number | null;
  lastErrorCode: string | null;
  terminalReason: string | null;
}
interface Observation {
  requests: Array<{
    path: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    receivedAt: number;
    endedAt: number | null;
  }>;
  businessEffects: number;
}
const demo = 'demo-token-change-me',
  other = 'other-token-change-me';
let api: string, mock: string;
const envelope = (key: string, path = '/success') => ({
  url: `http://mock:4000${path}`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': key,
    'X-Test-Secret': 'supplier-test-secret',
  },
  body: '{ "event": "paid", "amount": 100 }',
});
const submit = (key: string, body: unknown = envelope(key), token = demo) =>
  fetch(`${api}/v1/notifications`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
async function accept(key: string, path = '/success') {
  const response = await submit(key, envelope(key, path));
  expect(response.status).toBe(202);
  const result = (await response.json()) as Notification;
  expect(response.headers.get('location')).toBe(`/v1/notifications/${result.id}`);
  return result;
}
async function read(id: string, token = demo) {
  const response = await fetch(`${api}/v1/notifications/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Notification;
}
async function observe(key: string): Promise<Observation> {
  const response = await fetch(`${mock}/_observations?key=${encodeURIComponent(key)}`, {
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Observation;
}
const terminal = (id: string) =>
  eventually(
    () => read(id),
    (row) => ['succeeded', 'dead'].includes(row.status),
  );
const ready = () =>
  eventually(
    async () => {
      try {
        return (await fetch(`${api}/readyz`, { signal: AbortSignal.timeout(5000) })).status;
      } catch {
        return 0;
      }
    },
    (status) => status === 200,
  );

describe('HTTP notification behavior across real processes', () => {
  beforeAll(async () => {
    console.log(`Starting isolated E2E stack: ${project}`);
    await compose('up', '--build', '-d', '--wait', '--wait-timeout', '90');
    api = `http://${await compose('port', 'api', '3000')}`;
    mock = `http://${await compose('port', 'mock', '4000')}`;
    await ready();
    await eventually(async () => {
      try {
        return (await fetch(`${mock}/_stats`, { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        return false;
      }
    }, Boolean);
  });
  afterAll(async () => {
    try {
      await saveDiagnostics();
    } finally {
      await compose('down', '-v', '--remove-orphans');
    }
  });

  it('accepts while the worker is stopped, then delivers the exact saved request after it starts', async () => {
    const key = randomUUID();
    await compose('stop', 'worker');
    let row: Notification;
    try {
      row = await accept(key);
      expect(await read(row.id)).toMatchObject({ status: 'pending', attemptCount: 0 });
      expect((await observe(key)).requests).toHaveLength(0);
    } finally {
      await compose('start', 'worker');
    }
    expect(await terminal(row!.id)).toMatchObject({
      status: 'succeeded',
      attemptCount: 1,
      lastHttpStatus: 204,
    });
    const upstream = await observe(key);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      path: '/success',
      method: 'POST',
      body: envelope(key).body,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        'x-test-secret': 'supplier-test-secret',
      },
    });
    expect(JSON.stringify(await read(row!.id))).not.toContain('supplier-test-secret');
  });

  it('concurrent identical submissions and replay after completion cause only one upstream request', async () => {
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 12 }, () => submit(key)));
    expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(11);
    const ids = await Promise.all(
      responses.map(async (r) => ((await r.json()) as Notification).id),
    );
    expect(new Set(ids).size).toBe(1);
    await terminal(ids[0]!);
    const replay = await submit(key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: ids[0], status: 'succeeded' });
    await sleep(300);
    expect((await observe(key)).requests).toHaveLength(1);
  });

  it('rejects changed content under the same key without changing the delivered body', async () => {
    const key = randomUUID(),
      row = await accept(key);
    expect((await submit(key, { ...envelope(key), body: 'changed' })).status).toBe(409);
    await terminal(row.id);
    const upstream = await observe(key);
    expect(upstream.requests.map((r) => r.body)).toEqual([envelope(key).body]);
  });

  it('isolates callers and rejects invalid requests before the supplier sees them', async () => {
    const key = randomUUID(),
      row = await accept(key);
    const foreign = await fetch(`${api}/v1/notifications/${row.id}`, {
      headers: { Authorization: `Bearer ${other}` },
    });
    expect(foreign.status).toBe(404);
    const otherResponse = await submit(key, envelope(key), other);
    expect(otherResponse.status).toBe(202);
    const otherRow = (await otherResponse.json()) as Notification;
    expect(otherRow.id).not.toBe(row.id);
    await eventually(
      () => read(otherRow.id, other),
      (result) => result.status === 'succeeded',
    );
    const invalid = randomUUID();
    expect((await submit(invalid, envelope(invalid), 'wrong-token')).status).toBe(401);
    expect(
      (await submit(invalid, { ...envelope(invalid), headers: { Host: 'forged' } })).status,
    ).toBe(400);
    expect(
      (await submit(invalid, { ...envelope(invalid), body: 'x'.repeat(64 * 1024 + 1) })).status,
    ).toBe(413);
    expect(
      (await submit(invalid, { ...envelope(invalid), url: 'http://unapproved.example/path' }))
        .status,
    ).toBe(403);
    await terminal(row.id);
    await sleep(300);
    expect((await observe(invalid)).requests).toHaveLength(0);
  });

  it('recovers from two 503 responses, sending the same payload on all three attempts', async () => {
    const key = randomUUID(),
      row = await accept(key, '/flaky');
    expect(await terminal(row.id)).toMatchObject({ status: 'succeeded', attemptCount: 3 });
    const upstream = await observe(key);
    expect(upstream.requests).toHaveLength(3);
    expect(new Set(upstream.requests.map((r) => r.body))).toEqual(new Set([envelope(key).body]));
    expect(upstream.businessEffects).toBe(1);
  });

  it('waits at least Retry-After before the supplier receives another request', async () => {
    const key = randomUUID(),
      row = await accept(key, '/rate-limit');
    expect(await terminal(row.id)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    const upstream = await observe(key);
    expect(upstream.requests).toHaveLength(2);
    expect(
      upstream.requests[1]!.receivedAt - upstream.requests[0]!.receivedAt,
    ).toBeGreaterThanOrEqual(1000);
  });

  it('ends a rate-limited job when Retry-After would exceed its lifetime', async () => {
    const key = randomUUID(),
      row = await accept(key, '/rate-limit-long');
    expect(await terminal(row.id)).toMatchObject({
      status: 'dead',
      attemptCount: 1,
      lastHttpStatus: 429,
      terminalReason: 'expired',
    });
    expect((await observe(key)).requests).toHaveLength(1);
  });

  it.each(['/permanent', '/redirect'])(
    'ends %s after one request, with no redirect or later retry',
    async (path) => {
      const key = randomUUID(),
        row = await accept(key, path);
      expect(await terminal(row.id)).toMatchObject({
        status: 'dead',
        attemptCount: 1,
        terminalReason: 'non_retryable',
      });
      await sleep(300);
      expect((await observe(key)).requests.map((r) => r.path)).toEqual([path]);
    },
  );

  it.each(['/unavailable', '/timeout'])(
    'ends %s after the configured budget instead of retrying forever',
    async (path) => {
      const key = randomUUID(),
        row = await accept(key, path);
      expect(await terminal(row.id)).toMatchObject({
        status: 'dead',
        attemptCount: 3,
        maxAttempts: 3,
        terminalReason: 'attempts_exhausted',
      });
      await sleep(300);
      expect((await observe(key)).requests).toHaveLength(3);
    },
  );

  it('may resend after a lost response while the supplier applies the business effect once', async () => {
    const key = randomUUID(),
      row = await accept(key, '/dedupe-drop');
    expect(await terminal(row.id)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    const upstream = await observe(key);
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.businessEffects).toBe(1);
  });

  it('limits concurrent requests as measured by the supplier', async () => {
    const keys = Array.from({ length: 6 }, () => randomUUID());
    const rows = await Promise.all(keys.map((key) => accept(key, '/slow-success')));
    await Promise.all(rows.map((row) => terminal(row.id)));
    const observations = await Promise.all(keys.map(observe));
    const intervals = observations.flatMap((o) => o.requests);
    expect(intervals).toHaveLength(6);
    const edges = intervals.flatMap((r) => {
      expect(r.endedAt).not.toBeNull();
      return [
        [r.receivedAt, 1],
        [r.endedAt!, -1],
      ] as const;
    });
    let active = 0,
      peak = 0;
    for (const [, delta] of edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]))
      peak = Math.max(peak, (active += delta));
    expect(peak).toBe(2);
  });

  it('keeps accepted work and ingress idempotency across an API process restart', async () => {
    const key = randomUUID();
    await compose('stop', 'worker');
    let row: Notification;
    try {
      row = await accept(key);
      await compose('restart', 'api');
      api = `http://${await compose('port', 'api', '3000')}`;
      await ready();
      const replay = await submit(key);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ id: row.id, status: 'pending' });
    } finally {
      await compose('start', 'worker');
    }
    expect((await terminal(row!.id)).status).toBe('succeeded');
    expect((await observe(key)).requests).toHaveLength(1);
  });

  it('recovers after SIGKILL between the supplier effect and its HTTP response', async () => {
    const key = randomUUID(),
      row = await accept(key, '/commit-hang-once');
    await eventually(
      () => observe(key),
      (seen) => seen.businessEffects === 1,
    );
    expect((await read(row.id)).status).toBe('in_flight');
    try {
      await compose('kill', '-s', 'SIGKILL', 'worker');
    } finally {
      await compose('start', 'worker');
    }
    expect(await terminal(row.id)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    const upstream = await observe(key);
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.businessEffects).toBe(1);
  });

  it('preserves a 202-accepted job across Redis SIGKILL and returns 503 while Redis is down', async () => {
    const key = randomUUID();
    await compose('stop', 'worker');
    let row: Notification;
    try {
      row = await accept(key);
      await compose('kill', '-s', 'SIGKILL', 'redis');
      await eventually(
        async () => (await fetch(`${api}/readyz`, { signal: AbortSignal.timeout(5000) })).status,
        (status) => status === 503,
      );
      expect((await submit(randomUUID())).status).toBe(503);
      await compose('up', '-d', '--wait', 'redis');
      await ready();
      const replay = await submit(key);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ id: row.id, status: 'pending' });
    } finally {
      await compose('up', '-d', '--wait', 'redis', 'worker');
    }
    expect((await terminal(row!.id)).status).toBe('succeeded');
    expect((await observe(key)).requests).toHaveLength(1);
  });
});
