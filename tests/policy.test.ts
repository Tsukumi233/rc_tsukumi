import { describe, it, expect } from 'vitest';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { loadConfig } from '../src/config.js';
import { assertTargetAllowed, isPublicAddress, safeLookup } from '../src/target.js';
import { normalizeRequest } from '../src/api/contracts.js';
import { deliver, retryAfter } from '../src/worker/http.js';
import type { DeliveryTask } from '../src/domain.js';
import { configFor } from './helpers.js';

describe('Delivery policy and boundaries', () => {
  it('rejects non-public IPv4, IPv6 and mapped addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '2001:db8::1',
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('validates all DNS answers and passes the checked answers directly to the socket', async () => {
    const run = (addresses: LookupAddress[], all: boolean) =>
      new Promise<{
        error: NodeJS.ErrnoException | null;
        value: string | LookupAddress[];
        family?: number;
      }>((resolve) => {
        const resolver = ((
          _host: unknown,
          _options: unknown,
          callback: (e: null, a: LookupAddress[]) => void,
        ) => callback(null, addresses)) as unknown as typeof dnsLookup;
        safeLookup(false, resolver)('provider.example', { all }, (error, value, family) =>
          resolve({ error, value, family }),
        );
      });
    expect(
      (
        await run(
          [
            { address: '8.8.8.8', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ],
          true,
        )
      ).error?.message,
    ).toBe('target_not_allowed');
    expect(await run([{ address: '8.8.8.8', family: 4 }], true)).toMatchObject({
      error: null,
      value: [{ address: '8.8.8.8', family: 4 }],
    });
    expect(await run([{ address: '8.8.8.8', family: 4 }], false)).toMatchObject({
      error: null,
      value: '8.8.8.8',
      family: 4,
    });
  });
  it('uses exact origins and prohibits URL credentials, fragments and private literal targets', () => {
    const caller = {
      id: 'demo',
      token: 'demo-token-change-me',
      allowedOrigins: ['https://api.example.com', 'https://127.0.0.1'],
    };
    for (const url of [
      'https://api.example.com.attacker.test/path',
      'https://api.example.com:444/path',
      'https://user:pass@api.example.com/path',
      'https://api.example.com/path#secret',
      'https://127.0.0.1/',
    ]) {
      expect(() => assertTargetAllowed(url, caller, { allowPrivateTargets: false })).toThrow();
    }
    expect(
      assertTargetAllowed('https://api.example.com/path?a=1', caller, {
        allowPrivateTargets: false,
      }).origin,
    ).toBe('https://api.example.com');
  });
  it('blocks private DNS answers during the real HTTP connection, before sending a request', async () => {
    const config = { ...configFor('https://localhost:4000'), allowPrivateTargets: false };
    const task = {
      caller_id: 'demo',
      url: 'https://localhost:4000/success',
      method: 'POST',
      headers: {},
      body: null,
      attempt_count: 1,
    } as DeliveryTask;
    expect(await deliver(task, config)).toMatchObject({
      outcome: 'permanent_error',
      errorCode: 'target_not_allowed',
    });
  });
  it('keeps content hashes stable across header case/order but preserves body and query order', () => {
    const base = {
      url: 'https://api.example.com/?b=2&a=1',
      method: 'POST' as const,
      headers: { 'X-B': '2', 'X-A': '1' },
      body: '{"a":1}',
    };
    const a = normalizeRequest(base);
    const b = normalizeRequest({ ...base, headers: { 'x-a': '1', 'x-b': '2' } });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(normalizeRequest({ ...base, body: '{ "a": 1 }' }).hash);
    expect(a.hash).not.toBe(
      normalizeRequest({ ...base, url: 'https://api.example.com/?a=1&b=2' }).hash,
    );
    expect(normalizeRequest({ ...base, body: undefined }).hash).not.toBe(
      normalizeRequest({ ...base, body: '' }).hash,
    );
  });
  it('parses Retry-After seconds and HTTP dates without accepting arbitrary dates', () => {
    expect(retryAfter('3600').delayMs).toBe(3600000);
    expect(retryAfter('Sun, 13 Sep 2026 12:00:00 GMT').date?.toISOString()).toBe(
      '2026-09-13T12:00:00.000Z',
    );
    expect(retryAfter('invalid')).toEqual({ delayMs: 0 });
    expect(retryAfter('2099-01-01')).toEqual({ delayMs: 0 });
  });
  it('refuses unsafe production switches, duplicate identities and inconsistent lock durations', () => {
    const env = {
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
      ALLOW_PRIVATE_TARGETS: 'true',
      CALLERS_JSON: JSON.stringify(configFor().callers),
    };
    expect(loadConfig(env).concurrency).toBe(10);
    expect(() => loadConfig({ ...env, NODE_ENV: 'production' })).toThrow();
    expect(() => loadConfig({ ...env, HTTP_TIMEOUT_MS: '100', LOCK_MS: '100' })).toThrow();
    expect(() => loadConfig({ ...env, MAX_ATTEMPTS: '-1' })).toThrow();
    expect(() =>
      loadConfig({
        ...env,
        CALLERS_JSON: JSON.stringify([configFor().callers[0], configFor().callers[0]]),
      }),
    ).toThrow();
  });
});
