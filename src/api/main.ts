import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { loadConfig } from '../config.js';
import { Repository } from '../queue.js';
import { log } from '../log.js';
import { createApp } from './app.js';

try {
  const config = loadConfig();
  const repo = new Repository(config.redisUrl);
  try {
    await repo.ready();
  } catch (error) {
    await repo.close();
    throw error;
  }
  const app = createApp(repo, config);
  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, () =>
    log('api_started', { port: config.port }),
  ) as Server;
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('error', () => {
    log('api_server_error');
    process.exitCode = 1;
    void repo.close();
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => server.closeAllConnections(), 10000);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      void repo.close();
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch {
  log('startup_failed', { errorCode: 'invalid_configuration' });
  process.exitCode = 1;
}
