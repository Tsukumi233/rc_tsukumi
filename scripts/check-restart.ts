// Explicitly restarts this project's local Redis. Run only against the demo Compose stack.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
const docker = (...args: string[]) =>
  execFileSync('docker', ['compose', ...args], { stdio: 'inherit' });
const api = 'http://127.0.0.1:3000';
const key = `restart-${randomUUID()}`;
const headers = {
  Authorization: 'Bearer demo-token-change-me',
  'Content-Type': 'application/json',
  'Idempotency-Key': key,
};
const input = JSON.stringify({
  url: 'http://mock:4000/success',
  method: 'POST',
  headers: { 'Idempotency-Key': key },
  body: 'restart-check',
});
const read = async (id: string) => {
  const response = await fetch(`${api}/v1/notifications/${id}`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Read failed: ${response.status}`);
  return (await response.json()) as { id: string; status: string };
};
let id = '';
try {
  docker('stop', 'worker');
  const response = await fetch(`${api}/v1/notifications`, { method: 'POST', headers, body: input });
  if (response.status !== 202) throw new Error(`Acceptance failed: ${response.status}`);
  id = ((await response.json()) as { id: string }).id;
  if ((await read(id)).status !== 'pending') throw new Error('Job was not queued');
  docker('kill', '-s', 'SIGKILL', 'redis');
  docker('up', '-d', '--wait', 'redis');
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      ready = (await fetch(`${api}/readyz`, { signal: AbortSignal.timeout(5000) })).ok;
    } catch {
      /* reconnecting */
    }
    if (ready) break;
    await sleep(100);
  }
  if (!ready || (await read(id)).status !== 'pending')
    throw new Error('Accepted job did not survive Redis kill');
  const retry = await fetch(`${api}/v1/notifications`, { method: 'POST', headers, body: input });
  if (retry.status !== 200 || ((await retry.json()) as { id: string }).id !== id)
    throw new Error('Deduplication did not survive restart');
} finally {
  docker('up', '-d', '--wait', 'redis', 'worker');
}
let succeeded = false;
for (let i = 0; i < 100; i++) {
  if ((await read(id)).status === 'succeeded') {
    succeeded = true;
    break;
  }
  await sleep(100);
}
if (!succeeded) throw new Error('Recovered worker did not complete the job');
console.log(
  JSON.stringify({
    scenario: 'redis-sigkill',
    id,
    acceptedJobSurvived: true,
    idempotencySurvived: true,
    status: 'succeeded',
  }),
);
