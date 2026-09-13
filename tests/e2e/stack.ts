import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const run = promisify(execFile);
export const project = `rc-e2e-${randomUUID().slice(0, 8)}`;
export async function compose(...args: string[]) {
  const { stdout } = await run(
    'docker',
    ['compose', '-p', project, '-f', 'compose.e2e.yaml', ...args],
    {
      timeout: 150000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return stdout.trim();
}
export async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeout = 15000,
) {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  do {
    last = await read();
    if (done(last)) return last;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(
    `Behavior not observed within ${timeout} ms; last value: ${JSON.stringify(last)}`,
  );
}
export async function saveDiagnostics() {
  await mkdir('artifacts/e2e', { recursive: true });
  await writeFile('artifacts/e2e/compose.log', await compose('logs', '--no-color', '--timestamps'));
  await writeFile(
    'artifacts/e2e/containers.json',
    await compose('ps', '--all', '--format', 'json'),
  );
}
