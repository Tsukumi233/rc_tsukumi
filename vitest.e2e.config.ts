import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 180000,
    reporters: ['default', 'json'],
    outputFile: { json: 'artifacts/e2e/results.json' },
  },
});
