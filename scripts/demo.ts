import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const api = process.env.API_URL ?? 'http://127.0.0.1:3000';
const target = process.env.DEMO_TARGET_ORIGIN ?? 'http://127.0.0.1:4000';
const token = process.env.DEMO_TOKEN ?? 'demo-token-change-me';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
try {
  for (const path of ['success', 'flaky', 'rate-limit', 'permanent', 'dedupe-drop']) {
    const key = `demo-${path}-${randomUUID()}`;
    const input = JSON.stringify({
      url: `${target}/${path}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ eventId: key }),
    });
    const first = await fetch(`${api}/v1/notifications`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': key },
      body: input,
    });
    if (first.status !== 202) throw new Error(`Submission failed: ${first.status}`);
    const accepted = (await first.json()) as { id: string };
    const duplicate = await fetch(`${api}/v1/notifications`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': key },
      body: input,
    });
    const reused = (await duplicate.json()) as { id: string };
    if (duplicate.status !== 200 || reused.id !== accepted.id)
      throw new Error('Idempotency check failed');
    const deadline = Date.now() + 120000;
    let complete = false;
    while (Date.now() < deadline) {
      const response = await fetch(`${api}/v1/notifications/${accepted.id}`, { headers });
      if (!response.ok) throw new Error('Status query failed');
      const row = (await response.json()) as {
        status: string;
        attemptCount: number;
        lastHttpStatus: number | null;
      };
      if (['succeeded', 'dead'].includes(row.status)) {
        const expected = path === 'permanent' ? 'dead' : 'succeeded';
        if (row.status !== expected)
          throw new Error(`Unexpected result for ${path}: ${row.status}`);
        console.log(JSON.stringify({ scenario: path, id: accepted.id, ...row }));
        complete = true;
        break;
      }
      await sleep(250);
    }
    if (!complete) throw new Error(`Scenario timed out: ${path}`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
