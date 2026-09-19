import { loadLocalEnv } from '../../src/config/local-env.js';

/**
 * Vitest setup for real-database integration tests.
 *
 * Requires TEST_DATABASE_URL, refuses any database other than mansar_test,
 * and points DATABASE_URL at it for this test process only so the production
 * PrismaService is exercised against the isolated test database. Nothing is
 * printed.
 */
loadLocalEnv();

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error('TEST_DATABASE_URL is not set');
}

let databaseName: string;
try {
  databaseName = new URL(testUrl).pathname.replace(/^\//, '');
} catch {
  throw new Error('TEST_DATABASE_URL is not a valid URL');
}
if (databaseName !== 'mansar_test') {
  throw new Error('TEST_DATABASE_URL must target mansar_test');
}

process.env.DATABASE_URL = testUrl;
