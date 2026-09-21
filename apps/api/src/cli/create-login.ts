import { AuditService } from '../audit/audit.service.js';
import { DuplicateEmailError, PasswordPolicyError } from '../auth/errors.js';
import {
  PASSWORD_MAX_CODE_POINTS,
  PASSWORD_MIN_CODE_POINTS,
} from '../auth/password.js';
import { RefreshSessionService } from '../auth/refresh-session.service.js';
import { loadLocalEnv } from '../config/local-env.js';
import { PrismaService } from '../database/prisma.service.js';
import type { UserRole } from '../generated/prisma/enums.js';
import { type CreatedUser, UsersService } from '../users/users.service.js';
import { type PromptIo, readHidden, readLine } from './prompt.js';

/**
 * Interactive login-identity creation shared by `admin:create` and
 * `driver:create`. The role is fixed by the command that wires `create`;
 * it is never read from the terminal. The password is typed into a hidden
 * prompt and confirmed; it is never accepted from argv or the environment,
 * never written anywhere, and nothing secret is ever printed.
 */
export interface CreateLoginDeps {
  readonly io: PromptIo;
  /** Label shown in prompts and the confirmation line. */
  readonly role: UserRole;
  /** Trusted creator whose role is fixed (e.g. `UsersService.createDriverLogin`). */
  readonly create: (input: {
    readonly email: string;
    readonly password: string;
  }) => Promise<CreatedUser>;
}

export async function runCreateLogin(deps: CreateLoginDeps): Promise<number> {
  const { io, role } = deps;
  const label = role === 'ADMIN' ? 'Admin' : 'Driver';
  const email = (await readLine(io, `${label} email: `)).trim();
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
    const user = await deps.create({ email, password });
    io.output.write(`Created ${user.role} ${user.email} (${user.id}).\n`);
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

/**
 * Connects to DATABASE_URL (the local `.env` is loaded only when present),
 * runs one interactive creation through the given trusted creator and
 * disposes the pool. Used by the command entry points only.
 */
export async function runCliCommand(
  role: UserRole,
  select: (users: UsersService) => CreateLoginDeps['create'],
): Promise<void> {
  loadLocalEnv();
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  const users = new UsersService(
    prisma,
    new AuditService(prisma),
    new RefreshSessionService(prisma, new AuditService(prisma)),
  );
  try {
    process.exitCode = await runCreateLogin({
      io: { input: process.stdin, output: process.stdout },
      role,
      create: select(users),
    });
  } finally {
    await prisma.onModuleDestroy();
  }
}
