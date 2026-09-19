import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads the git-ignored `apps/api/.env` for local development using Node's
 * built-in loader. Variables already present in the process environment take
 * precedence, so platform-provided configuration is never overridden. Only a
 * missing file is tolerated; other errors (permissions, malformed content) are
 * surfaced. Deployed environments are expected to set variables directly.
 */
export function loadLocalEnv(): void {
  const envFile = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '.env',
  );

  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
}
