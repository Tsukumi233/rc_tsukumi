import { createWorker } from '../../src/worker/worker.js';
import { deliver } from '../../src/worker/http.js';
import type { Config } from '../../src/config.js';
const config = JSON.parse(process.env.TEST_CONFIG!) as Config;
createWorker(config, process.env.TEST_QUEUE!, async (task, cfg) => {
  if (process.env.CHECKPOINT === 'after_http') await deliver(task, cfg);
  process.send?.({ checkpoint: process.env.CHECKPOINT, id: task.id });
  return new Promise(() => {});
});
