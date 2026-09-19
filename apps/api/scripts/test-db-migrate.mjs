// Runs Prisma Migrate against the integration-test database.
//
// Usage: node scripts/test-db-migrate.mjs <deploy|status>
//
// Reads TEST_DATABASE_URL (from the process or the git-ignored apps/api/.env),
// refuses any database other than mansar_test, and invokes the local Prisma 7
// CLI with DATABASE_URL set to that value in the child process only. The URL
// is never printed. Deliberately narrow: only migrate deploy/status.
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowed = new Set(['deploy', 'status']);
const subcommand = process.argv[2];

if (!allowed.has(subcommand)) {
  console.error('Usage: node scripts/test-db-migrate.mjs <deploy|status>');
  process.exit(2);
}

try {
  process.loadEnvFile(path.join(apiDir, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  console.error('TEST_DATABASE_URL is not set');
  process.exit(1);
}

let databaseName;
try {
  databaseName = new URL(testUrl).pathname.replace(/^\//, '');
} catch {
  console.error('TEST_DATABASE_URL is not a valid URL');
  process.exit(1);
}
if (databaseName !== 'mansar_test') {
  console.error('TEST_DATABASE_URL must target mansar_test');
  process.exit(1);
}

const prismaCli = createRequire(path.join(apiDir, 'package.json')).resolve(
  'prisma/build/index.js',
);

const result = spawnSync(
  process.execPath,
  [prismaCli, 'migrate', subcommand, '--config', './prisma7.config.ts'],
  {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'inherit',
  },
);

process.exit(result.status ?? 1);
