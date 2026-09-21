import { pathToFileURL } from 'node:url';

import type { UsersService } from '../users/users.service.js';
import { runCliCommand, runCreateLogin } from './create-login.js';
import type { PromptIo } from './prompt.js';

/**
 * Interactive synthetic DRIVER login creation (staging / development).
 *
 *   npm run driver:create -w @mansar/api
 *
 * Creates a `User` with role DRIVER and nothing else: no operational driver
 * record, no session, no token (ADR 0002: a login is not a driver). Needs
 * DATABASE_URL only. Same hidden, confirmed password prompt as
 * `admin:create`; the role is fixed to DRIVER here and cannot be chosen.
 */
export interface CreateDriverDeps {
  readonly io: PromptIo;
  readonly createDriver: UsersService['createDriverLogin'];
}

export function runCreateDriver(deps: CreateDriverDeps): Promise<number> {
  return runCreateLogin({
    io: deps.io,
    role: 'DRIVER',
    create: deps.createDriver,
  });
}

// Only run as a command; importing this module (tests) must not connect.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCliCommand(
    'DRIVER',
    (users) => (input) => users.createDriverLogin(input),
  );
}
