import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { DuplicateEmailError, PasswordPolicyError } from '../auth/errors.js';
import { runCreateDriver } from './create-driver.js';
import type { PromptIo } from './prompt.js';

/** Same fake-terminal driver as create-admin.spec.ts. */
function makeIo(
  lines: string[],
  tty: boolean,
): { io: PromptIo; written: () => string } {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
  };
  input.isTTY = tty;
  if (tty) {
    input.setRawMode = vi.fn();
  }
  const output = new PassThrough();
  let captured = '';
  output.on('data', (chunk: Buffer) => {
    captured += chunk.toString('utf8');
  });
  let index = 0;
  const feed = () => {
    if (index < lines.length) {
      input.write(`${lines[index]!}\n`);
      index += 1;
    }
  };
  const originalWrite = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const result = (originalWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest,
    );
    if (String(chunk).endsWith(': ')) {
      setImmediate(feed);
    }
    return result;
  }) as typeof output.write;
  return {
    io: {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    },
    written: () => captured,
  };
}

const DRIVER = {
  id: '019a0000-0000-7000-8000-00000000d001',
  email: 'staging-driver@example.test',
  role: 'DRIVER',
} as const;

describe('runCreateDriver', () => {
  it('prompts for email and a hidden confirmed password, creates through the DRIVER creator and prints only safe metadata', async () => {
    const { io, written } = makeIo(
      [
        ' Staging-Driver@Example.test ',
        'synthetic driver pw',
        'synthetic driver pw',
      ],
      true,
    );
    const createDriver = vi.fn().mockResolvedValue(DRIVER);

    await expect(runCreateDriver({ io, createDriver })).resolves.toBe(0);

    // Trimmed here; full normalization (NFC, lowercase) is the service's job.
    expect(createDriver).toHaveBeenCalledWith({
      email: 'Staging-Driver@Example.test',
      password: 'synthetic driver pw',
    });
    expect(written()).toContain('Driver email: ');
    expect(written()).toContain('Password (hidden): ');
    expect(written()).toContain('Confirm password (hidden): ');
    expect(written()).toContain(
      'Created DRIVER staging-driver@example.test (019a0000-0000-7000-8000-00000000d001).',
    );
    expect(written()).not.toContain('synthetic driver pw');
    expect(written()).not.toContain('ADMIN');
  });

  it('never reads a password from argv or the environment', async () => {
    const { io } = makeIo(
      [
        'staging-driver@example.test',
        'typed synthetic pw',
        'typed synthetic pw',
      ],
      true,
    );
    const createDriver = vi.fn().mockResolvedValue(DRIVER);
    const argvBefore = [...process.argv];
    process.argv.push('--password=argv-marker', 'argv-marker');
    process.env.DRIVER_PASSWORD = 'env-marker';
    try {
      await runCreateDriver({ io, createDriver });
    } finally {
      process.argv.length = 0;
      process.argv.push(...argvBefore);
      delete process.env.DRIVER_PASSWORD;
    }
    expect(createDriver).toHaveBeenCalledWith({
      email: 'staging-driver@example.test',
      password: 'typed synthetic pw',
    });
  });

  it('refuses hidden input without a TTY and never echoes', async () => {
    const { io, written } = makeIo(
      ['staging-driver@example.test', 'pw-marker', 'pw-marker'],
      false,
    );
    const createDriver = vi.fn();
    await expect(runCreateDriver({ io, createDriver })).resolves.toBe(1);
    expect(createDriver).not.toHaveBeenCalled();
    expect(written()).toContain('interactive terminal');
    expect(written()).not.toContain('pw-marker');
  });

  it('aborts on mismatched confirmation, policy violation, duplicate email and empty email', async () => {
    const mismatch = makeIo(
      ['d@example.test', 'one synthetic value', 'two synthetic value'],
      true,
    );
    const noCall = vi.fn();
    await expect(
      runCreateDriver({ io: mismatch.io, createDriver: noCall }),
    ).resolves.toBe(1);
    expect(noCall).not.toHaveBeenCalled();
    expect(mismatch.written()).toContain('do not match');

    const short = makeIo(['d@example.test', 'short', 'short'], true);
    await expect(
      runCreateDriver({
        io: short.io,
        createDriver: vi
          .fn()
          .mockRejectedValue(new PasswordPolicyError('password_too_short')),
      }),
    ).resolves.toBe(1);
    expect(short.written()).toContain('15-128');

    const dup = makeIo(
      ['d@example.test', 'synthetic driver pw', 'synthetic driver pw'],
      true,
    );
    await expect(
      runCreateDriver({
        io: dup.io,
        createDriver: vi.fn().mockRejectedValue(new DuplicateEmailError()),
      }),
    ).resolves.toBe(1);
    expect(dup.written()).toContain('already exists');

    const empty = makeIo(['   '], true);
    const untouched = vi.fn();
    await expect(
      runCreateDriver({ io: empty.io, createDriver: untouched }),
    ).resolves.toBe(1);
    expect(empty.written()).toContain('email is required');
    expect(untouched).not.toHaveBeenCalled();
  });

  it('exposes no way to choose a role: the creator decides it', () => {
    // Type-level contract: deps carry only io and the fixed DRIVER creator.
    const deps: Parameters<typeof runCreateDriver>[0] = {
      io: makeIo([], true).io,
      createDriver: vi.fn(),
    };
    expect(Object.keys(deps).sort()).toEqual(['createDriver', 'io']);
  });
});
