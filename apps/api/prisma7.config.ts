import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'prisma/config';

/**
 * Prisma ORM 7 CLI configuration.
 *
 * Local CLI use loads `apps/api/.env` (git-ignored) with Node's built-in
 * loader. Variables already present in the process take precedence, and only
 * a missing file is tolerated; any other error is surfaced.
 */
const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');

try {
  process.loadEnvFile(envFile);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT') {
    throw error;
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Empty when unset so `prisma generate` works without a database.
    // Commands that need a connection then fail clearly on the empty URL.
    url: process.env.DATABASE_URL ?? '',
  },
});
