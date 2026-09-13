import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/api/app.js';
import { Repository } from '../src/queue.js';
import { configFor, testQueue } from './helpers.js';

describe('API contract with BullMQ and persistent Redis', () => {
  let db: Awaited<ReturnType<typeof testQueue>>;
  let app: ReturnType<typeof createApp>;
  const config = configFor();
  const body = {
    url: 'http://127.0.0.1:4000/success',
    method: 'POST',
    headers: { 'X-Secret': 'do-not-return' },
    body: '{"n":1}',
  };
  const submit = (key = randomUUID(), input: unknown = body, token = 'demo-token-change-me') =>
    app.request('/v1/notifications', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
  beforeAll(async () => {
    db = await testQueue();
    app = createApp(db.repo, config);
  });
  beforeEach(async () => db.reset());
  afterAll(async () => db.close());

  it('commits before 202; duplicate submission returns the same ID without exposing credentials', async () => {
    const key = randomUUID();
    const response = await submit(key);
    const first = await response.json();
    expect(response.status).toBe(202);
    expect(response.headers.get('location')).toBe(`/v1/notifications/${first.id}`);
    expect((await db.repo.get(first.id, 'demo'))?.status).toBe('pending');
    const replay = await submit(key);
    expect(replay.status).toBe(200);
    expect((await replay.json()).id).toBe(first.id);
    const read = await app.request(`/v1/notifications/${first.id}`, {
      headers: { Authorization: 'Bearer demo-token-change-me' },
    });
    expect(read.status).toBe(200);
    expect(await read.text()).not.toContain('do-not-return');
  });
  it('serializes concurrent identical submissions using the library atomic job ID check', async () => {
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 12 }, () => submit(key)));
    expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(11);
    const ids = await Promise.all(responses.map(async (r) => (await r.json()).id));
    expect(new Set(ids).size).toBe(1);
  });
  it('survives enqueue acknowledgement loss without duplicating the stored request', async () => {
    const original = db.repo.queue.add.bind(db.repo.queue);
    const spy = vi.spyOn(db.repo.queue, 'add').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('injected acknowledgement loss');
    });
    const key = randomUUID();
    expect((await submit(key)).status).toBe(503);
    spy.mockRestore();
    const retry = await submit(key);
    expect(retry.status).toBe(200);
    expect(await db.repo.queue.getWaitingCount()).toBe(1);
  });
  it('does not acknowledge an enqueue that fails before persistence', async () => {
    const spy = vi
      .spyOn(db.repo.queue, 'add')
      .mockRejectedValueOnce(new Error('injected storage failure'));
    expect((await submit()).status).toBe(503);
    expect(await db.repo.queue.getWaitingCount()).toBe(0);
    spy.mockRestore();
  });
  it('rejects concurrent same-key different-body requests', async () => {
    const key = randomUUID();
    const responses = await Promise.all([submit(key), submit(key, { ...body, body: 'different' })]);
    expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
  });
  it('scopes keys and reads to the authenticated caller', async () => {
    const key = randomUUID();
    const a = await (await submit(key)).json();
    const b = await (await submit(key, body, 'other-token-change-me')).json();
    expect(a.id).not.toBe(b.id);
    const response = await app.request(`/v1/notifications/${a.id}`, {
      headers: { Authorization: 'Bearer other-token-change-me' },
    });
    expect(response.status).toBe(404);
  });
  it('rejects unauthenticated calls, unknown targets, invalid payloads and controlled headers', async () => {
    expect((await submit(undefined, body, 'bad-token')).status).toBe(401);
    expect(
      (await submit(undefined, { ...body, url: 'http://unapproved.example/success' })).status,
    ).toBe(403);
    expect((await submit(undefined, { ...body, method: 'GET' })).status).toBe(400);
    expect((await submit(undefined, { ...body, headers: { Host: 'elsewhere' } })).status).toBe(400);
    expect((await submit(undefined, { ...body, headers: { 'X-A': '1', 'x-a': '2' } })).status).toBe(
      400,
    );
    expect((await submit(undefined, { ...body, body: '\0' })).status).toBe(400);
    expect((await submit(undefined, { ...body, body: '\ud800' })).status).toBe(400);
    expect((await submit(undefined, { ...body, sourceSystem: 'spoofed' })).status).toBe(400);
  });
  it('enforces raw and decoded UTF-8 byte limits, including chunked bodies', async () => {
    expect((await submit(undefined, { ...body, body: '中'.repeat(30000) })).status).toBe(413);
    const bytes = new TextEncoder().encode('x'.repeat(600000));
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    const response = await app.request('/v1/notifications', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer demo-token-change-me',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'large',
        'Content-Length': '1',
      },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(response.status).toBe(413);
  });
  it('returns 503 rather than 202 when storage cannot commit', async () => {
    const repo = new Repository('redis://127.0.0.1:1');
    try {
      const unavailable = createApp(repo, config);
      const response = await unavailable.request('/v1/notifications', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer demo-token-change-me',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'offline',
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(503);
    } finally {
      await repo.close();
    }
  });
  it('fails readiness when AOF reports a write failure', async () => {
    const spy = vi
      .spyOn(db.repo.client, 'info')
      .mockResolvedValueOnce('aof_last_write_status:err\r\n');
    try {
      expect((await app.request('/readyz')).status).toBe(503);
    } finally {
      spy.mockRestore();
    }
  });
  it('generates both documented API routes and serves readiness', async () => {
    const spec = await (await app.request('/openapi.json')).json();
    expect(spec.paths['/v1/notifications'].post.responses['202']).toBeDefined();
    expect(spec.paths['/v1/notifications/{id}'].get).toBeDefined();
    expect((await app.request('/readyz')).status).toBe(200);
  });
});
