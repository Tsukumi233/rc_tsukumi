import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
  },
});
