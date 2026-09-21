import { pathToFileURL } from 'node:url';

import type { UsersService } from '../users/users.service.js';
import { runCliCommand, runCreateLogin } from './create-login.js';
import type { PromptIo } from './prompt.js';

/**
 * Interactive initial-ADMIN creation.
 *
 *   npm run admin:create -w @mansar/api
 *
 * Needs DATABASE_URL only (no JWT secret). Shares the prompt flow with
 * `driver:create` (see create-login.ts); the role is fixed to ADMIN here.
 */
export interface CreateAdminDeps {
  readonly io: PromptIo;
  readonly createAdmin: UsersService['createInitialAdmin'];
}

export function runCreateAdmin(deps: CreateAdminDeps): Promise<number> {
  return runCreateLogin({
    io: deps.io,
    role: 'ADMIN',
    create: deps.createAdmin,
  });
}

// Only run as a command; importing this module (tests) must not connect.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCliCommand(
    'ADMIN',
    (users) => (input) => users.createInitialAdmin(input),
  );
}
