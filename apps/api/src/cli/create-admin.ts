import { pathToFileURL } from 'node:url';

import { AuditService } from '../audit/audit.service.js';
import { DuplicateEmailError, PasswordPolicyError } from '../auth/errors.js';
import {
  PASSWORD_MAX_CODE_POINTS,
  PASSWORD_MIN_CODE_POINTS,
} from '../auth/password.js';
import { RefreshSessionService } from '../auth/refresh-session.service.js';
import { loadLocalEnv } from '../config/local-env.js';
import { PrismaService } from '../database/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { type PromptIo, readHidden, readLine } from './prompt.js';

/**
 * Interactive initial-ADMIN creation.
 *
 *   npm run admin:create -w @mansar/api
 *
 * Needs DATABASE_URL only (no JWT secret). The password is typed into a
 * hidden prompt and confirmed; it is never accepted from argv or the
 * environment, and nothing secret is ever printed.
 */
export interface CreateAdminDeps {
  readonly io: PromptIo;
  readonly createAdmin: UsersService['createInitialAdmin'];
}

export async function runCreateAdmin(deps: CreateAdminDeps): Promise<number> {
  const { io } = deps;
  const email = (await readLine(io, 'Admin email: ')).trim();
  if (!email) {
    io.output.write('Aborted: email is required.\n');
    return 1;
  }

  let password: string;
  let confirmation: string;
  try {
    password = await readHidden(io, 'Password (hidden): ');
    confirmation = await readHidden(io, 'Confirm password (hidden): ');
  } catch (error) {
    io.output.write(
      `Aborted: ${(error as Error).message}. Run this command in an interactive terminal.\n`,
    );
    return 1;
  }
  if (password !== confirmation) {
    io.output.write('Aborted: passwords do not match.\n');
    return 1;
  }

  try {
    const user = await deps.createAdmin({ email, password });
    io.output.write(`Created ADMIN ${user.email} (${user.id}).\n`);
    return 0;
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      io.output.write(
        `Aborted: password must be ${PASSWORD_MIN_CODE_POINTS}-${PASSWORD_MAX_CODE_POINTS} characters.\n`,
      );
      return 1;
    }
    if (error instanceof DuplicateEmailError) {
      io.output.write('Aborted: a user with that email already exists.\n');
      return 1;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  const users = new UsersService(
    prisma,
    new AuditService(prisma),
    new RefreshSessionService(prisma, new AuditService(prisma)),
  );
  try {
    process.exitCode = await runCreateAdmin({
      io: { input: process.stdin, output: process.stdout },
      createAdmin: (input) => users.createInitialAdmin(input),
    });
  } finally {
    await prisma.onModuleDestroy();
  }
}

// Only run as a command; importing this module (tests) must not connect.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
