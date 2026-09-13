import { createHash, timingSafeEqual } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { Caller, Config } from '../config.js';
import type { Repository } from '../queue.js';
import { RequestError } from '../errors.js';
import { log } from '../log.js';
import { assertTargetAllowed } from '../target.js';
import {
  errorSchema,
  normalizeRequest,
  notificationSchema,
  submissionSchema,
} from './contracts.js';

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: errorSchema } },
});
const successResponse = {
  description: 'Persisted notification status',
  content: { 'application/json': { schema: notificationSchema } },
};
const errorResponses = {
  400: errorResponse('Invalid request'),
  401: errorResponse('Invalid internal credentials'),
  403: errorResponse('Target not permitted'),
  409: errorResponse('Idempotency key reused with different content'),
  413: errorResponse('Request too large'),
  503: errorResponse('Storage unavailable; retry with the same key'),
};

export function createApp(repo: Repository, config: Config) {
  const app = new OpenAPIHono<{ Variables: { caller: Caller } }>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid_request' }, 400);
    },
  });
  const tokens = config.callers.map((caller) => ({
    caller,
    hash: createHash('sha256').update(caller.token).digest(),
  }));
  app.use('/v1/*', async (c, next) => {
    const auth = c.req.header('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
    const hash = createHash('sha256').update(auth.slice(7)).digest();
    const caller = tokens.find((item) => timingSafeEqual(item.hash, hash))?.caller;
    if (!caller) return c.json({ error: 'unauthorized' }, 401);
    c.set('caller', caller);
    await next();
  });
  app.use('/v1/notifications', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 512 * 1024) {
          void reader.cancel().catch(() => {});
          return c.json({ error: 'request_too_large' }, 413);
        }
        chunks.push(value);
      }
      c.req.raw = new Request(c.req.raw, { body: new Uint8Array(Buffer.concat(chunks)) });
    }
    await next();
  });
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/notifications',
      tags: ['Notifications'],
      security: [{ bearerAuth: [] }],
      summary: 'Durably accept an HTTP notification',
      request: {
        headers: z.object({
          'idempotency-key': z
            .string()
            .min(1)
            .max(128)
            .regex(/^[\x21-\x7e]+$/),
        }),
        body: { required: true, content: { 'application/json': { schema: submissionSchema } } },
      },
      responses: { 202: successResponse, 200: successResponse, ...errorResponses },
    }),
    async (c) => {
      const input = c.req.valid('json');
      const caller = c.get('caller');
      assertTargetAllowed(input.url, caller, config);
      const { envelope, hash } = normalizeRequest(input);
      const accepted = await repo.accept(
        caller.id,
        c.req.valid('header')['idempotency-key'],
        envelope,
        hash,
        config,
      );
      c.header('Location', `/v1/notifications/${accepted.notification.id}`);
      if (accepted.created)
        log('notification_accepted', {
          notificationId: accepted.notification.id,
          callerId: caller.id,
        });
      return c.json(accepted.notification, accepted.created ? 202 : 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/notifications/{id}',
      tags: ['Notifications'],
      security: [{ bearerAuth: [] }],
      summary: 'Read status without exposing request credentials',
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: successResponse,
        404: errorResponse('Not found'),
        400: errorResponses[400],
        401: errorResponses[401],
        503: errorResponses[503],
      },
    }),
    async (c) => {
      const row = await repo.get(c.req.valid('param').id, c.get('caller').id);
      return row ? c.json(row, 200) : c.json({ error: 'not_found' }, 404);
    },
  );
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', async (c) => {
    await repo.ready();
    return c.json({ status: 'ready' });
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
  });
  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'HTTP Notification Service',
      version: '0.1.0',
      description:
        'Durable acceptance, bounded retries, possible duplicate delivery. A 2xx from the destination does not prove business completion.',
    },
  });
  app.get('/docs', (c) =>
    c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notification API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head><body><div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',persistAuthorization:false});</script></body></html>`),
  );
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    if (error instanceof RequestError) return c.json({ error: error.code }, error.status);
    if (error instanceof HTTPException && error.status === 400)
      return c.json({ error: 'invalid_request' }, 400);
    log('api_error', { errorCode: 'internal_or_storage_error' });
    return c.json({ error: 'service_unavailable' }, 503);
  });
  return app;
}
