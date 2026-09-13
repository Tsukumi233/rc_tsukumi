import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const api = process.env.API_URL ?? 'http://127.0.0.1:3000';
const target = process.env.DEMO_TARGET_ORIGIN ?? 'http://mock:4000';
const count = Number(process.env.BENCH_COUNT ?? 100);
if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Invalid BENCH_COUNT');
const headers = {
  Authorization: `Bearer ${process.env.DEMO_TOKEN ?? 'demo-token-change-me'}`,
  'Content-Type': 'application/json',
};
const pending = new Map<string, number>();
const acceptLatencies: number[] = [],
  deliveryLatencies: number[] = [];
let next = 0;
const began = performance.now();
await Promise.all(
  Array.from({ length: Math.min(10, count) }, async () => {
    while (next++ < count) {
      const key = randomUUID(),
        started = performance.now();
      const response = await fetch(`${api}/v1/notifications`, {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': key },
        body: JSON.stringify({
          url: `${target}/success`,
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: 'x'.repeat(1024),
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 202) throw new Error(`Enqueue failed: ${response.status}`);
      const row = (await response.json()) as { id: string };
      acceptLatencies.push(performance.now() - started);
      pending.set(row.id, started);
    }
  }),
);
const acceptedMs = performance.now() - began;
while (pending.size) {
  if (performance.now() - began > 120000) throw new Error('Benchmark timed out');
  await Promise.all(
    [...pending].map(async ([id, started]) => {
      const response = await fetch(`${api}/v1/notifications/${id}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Read failed: ${response.status}`);
      const row = (await response.json()) as { status: string };
      if (row.status === 'dead') throw new Error('Unexpected dead notification');
      if (row.status === 'succeeded') {
        deliveryLatencies.push(performance.now() - started);
        pending.delete(id);
      }
    }),
  );
  if (pending.size) await sleep(100);
}
const elapsedMs = performance.now() - began;
const percentile = (values: number[], p: number) =>
  Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!);
console.log(
  JSON.stringify({
    label: process.env.BENCH_LABEL ?? 'bullmq-redis',
    count,
    bodyBytes: 1024,
    producerConcurrency: 10,
    acceptedMs: Math.round(acceptedMs),
    elapsedMs: Math.round(elapsedMs),
    deliveredPerSecond: Math.round((count / elapsedMs) * 1000),
    acceptP95Ms: percentile(acceptLatencies, 0.95),
    observedDeliveryP95Ms: percentile(deliveryLatencies, 0.95),
  }),
);
