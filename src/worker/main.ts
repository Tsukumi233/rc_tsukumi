import { loadConfig } from '../config.js';
import { Repository } from '../queue.js';
import { log } from '../log.js';
import { createWorker } from './worker.js';

try {
  const config = loadConfig();
  const repo = new Repository(config.redisUrl);
  try {
    await repo.ready();
  } finally {
    await repo.close();
  }
  const worker = createWorker(config);
  await worker.waitUntilReady();
  log('worker_started');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await worker.close();
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
} catch {
  log('worker_stopped_with_error');
  process.exitCode = 1;
}
