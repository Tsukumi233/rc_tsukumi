import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export function createMockProvider() {
  const calls = new Map<string, number>();
  const effects = new Set<string>();
  const received: Array<{
    path: string;
    method: string;
    headers: IncomingHttpHeaders;
    body: string;
    receivedAt: number;
    endedAt: number | null;
  }> = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://mock').pathname;
    if (path === '/_observations') {
      const key = new URL(req.url!, 'http://mock').searchParams.get('key');
      if (!key) {
        res.writeHead(400).end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          requests: received.filter((r) => r.headers['idempotency-key'] === key),
          businessEffects: [...effects].filter((effect) => effect.endsWith(`:${key}`)).length,
        }),
      );
      return;
    }
    if (path === '/_stats') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ calls: Object.fromEntries(calls), businessEffects: effects.size }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 128 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const observation: (typeof received)[number] = {
        path,
        method: req.method!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        receivedAt: Date.now(),
        endedAt: null,
      };
      received.push(observation);
      res.once('close', () => {
        observation.endedAt = Date.now();
      });
      const key = `${path}:${req.headers['idempotency-key'] ?? 'anonymous'}`;
      const count = (calls.get(key) ?? 0) + 1;
      calls.set(key, count);
      if (path === '/stream') {
        res.writeHead(200);
        res.flushHeaders();
        const interval = setInterval(() => res.write('unbounded response'), 10);
        res.once('close', () => clearInterval(interval));
        return;
      }
      if (path === '/timeout') return;
      if (path === '/commit-hang-once') {
        effects.add(key);
        if (count === 1) return;
      }
      if (path === '/slow-success') await new Promise((resolve) => setTimeout(resolve, 200));
      if (path === '/unavailable') {
        res.writeHead(503).end();
        return;
      }
      if (path === '/redirect') {
        res.writeHead(302, { Location: '/success' }).end();
        return;
      }
      if (path === '/permanent') {
        res.writeHead(400).end();
        return;
      }
      if (path === '/flaky' && count <= 2) {
        res.writeHead(503).end();
        return;
      }
      if (path === '/rate-limit-long') {
        res.writeHead(429, { 'Retry-After': '120' }).end();
        return;
      }
      if (path === '/rate-limit' && count === 1) {
        res.writeHead(429, { 'Retry-After': '1' }).end();
        return;
      }
      if (path === '/dedupe-drop') {
        effects.add(key);
        if (count === 1) {
          res.destroy();
          return;
        }
      } else effects.add(key);
      res.writeHead(204).end();
    } catch {
      res.destroy();
    }
  });
  return {
    server,
    calls,
    effects,
    received,
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
