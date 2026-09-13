import { createHash } from 'node:crypto';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { z } from '@hono/zod-openapi';
import { RequestError } from '../errors.js';
import type { Envelope } from '../domain.js';

export const submissionSchema = z
  .object({
    url: z.string().max(4096).url(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.string().optional(),
  })
  .strict()
  .openapi('NotificationRequest');

export const errorSchema = z.object({ error: z.string() }).openapi('Error');
export const notificationSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(['pending', 'in_flight', 'succeeded', 'dead']),
    attemptCount: z.number().int(),
    maxAttempts: z.number().int(),
    nextAttemptAt: z.string().datetime().nullable(),
    expiresAt: z.string().datetime(),
    lastHttpStatus: z.number().int().nullable(),
    lastErrorCode: z.string().nullable(),
    terminalReason: z.string().nullable(),
    createdAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
  })
  .openapi('Notification');

const forbiddenHeaders = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'proxy-authorization',
  'proxy-authenticate',
]);

export function normalizeRequest(input: z.infer<typeof submissionSchema>): {
  envelope: Envelope;
  hash: string;
} {
  if (input.body !== undefined && (!input.body.isWellFormed() || input.body.includes('\0')))
    throw new RequestError('invalid_body', 400);
  if (input.body !== undefined && Buffer.byteLength(input.body, 'utf8') > 64 * 1024)
    throw new RequestError('body_too_large', 413);
  if (input.method === 'GET' && input.body !== undefined)
    throw new RequestError('get_body_not_allowed', 400);
  const entries = Object.entries(input.headers);
  if (entries.length > 64 || Buffer.byteLength(JSON.stringify(input.headers)) > 16 * 1024)
    throw new RequestError('headers_too_large', 413);
  const normalized = new Map<string, string>();
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    try {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    } catch {
      throw new RequestError('invalid_header', 400);
    }
    if (normalized.has(lower) || forbiddenHeaders.has(lower) || lower.startsWith('proxy-'))
      throw new RequestError('invalid_header', 400);
    normalized.set(lower, value);
  }
  const envelope: Envelope = {
    url: new URL(input.url).href,
    method: input.method,
    headers: Object.fromEntries([...normalized].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    body: input.body ?? null,
  };
  return { envelope, hash: createHash('sha256').update(JSON.stringify(envelope)).digest('hex') };
}
