import { defineConfig } from 'vitest/config';

/**
 * Real PostgreSQL integration tests (npm run test:db). Separate from the
 * DB-free default suite; runs serially against the shared test database.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.int-spec.ts'],
    setupFiles: ['./test/support/test-database-env.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
