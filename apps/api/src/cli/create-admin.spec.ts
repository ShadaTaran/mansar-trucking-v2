import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { DuplicateEmailError, PasswordPolicyError } from '../auth/errors.js';
import { runCreateAdmin } from './create-admin.js';
import type { PromptIo } from './prompt.js';

/**
 * Drives the CLI with fake streams. A fake TTY implements setRawMode so the
 * hidden prompt path runs; a non-TTY input proves the safe refusal.
 */
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
  // Each prompt consumes one line; feed them lazily so readline and the raw
  // reader each see only their own input.
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

describe('runCreateAdmin', () => {
  it('creates the admin from prompted input and prints only a safe confirmation', async () => {
    const { io, written } = makeIo(
      ['admin@example.test', 'synthetic admin pw', 'synthetic admin pw'],
      true,
    );
    const createAdmin = vi.fn().mockResolvedValue({
      id: '019a0000-0000-7000-8000-000000000001',
      email: 'admin@example.test',
      role: 'ADMIN',
    });

    await expect(runCreateAdmin({ io, createAdmin })).resolves.toBe(0);

    expect(createAdmin).toHaveBeenCalledWith({
      email: 'admin@example.test',
      password: 'synthetic admin pw',
    });
    expect(written()).toContain('Created ADMIN admin@example.test');
    expect(written()).not.toContain('synthetic admin pw');
  });

  it('refuses hidden input without a TTY and never echoes', async () => {
    const { io, written } = makeIo(
      ['admin@example.test', 'pw-marker', 'pw-marker'],
      false,
    );
    const createAdmin = vi.fn();
    await expect(runCreateAdmin({ io, createAdmin })).resolves.toBe(1);
    expect(createAdmin).not.toHaveBeenCalled();
    expect(written()).toContain('interactive terminal');
    expect(written()).not.toContain('pw-marker');
  });

  it('aborts on mismatched confirmation, policy violation and duplicate email', async () => {
    const mismatch = makeIo(
      ['a@example.test', 'one synthetic value', 'two synthetic value'],
      true,
    );
    const noCall = vi.fn();
    await expect(
      runCreateAdmin({ io: mismatch.io, createAdmin: noCall }),
    ).resolves.toBe(1);
    expect(noCall).not.toHaveBeenCalled();
    expect(mismatch.written()).toContain('do not match');

    const short = makeIo(['a@example.test', 'short', 'short'], true);
    await expect(
      runCreateAdmin({
        io: short.io,
        createAdmin: vi
          .fn()
          .mockRejectedValue(new PasswordPolicyError('password_too_short')),
      }),
    ).resolves.toBe(1);
    expect(short.written()).toContain('15-128');

    const dup = makeIo(
      ['a@example.test', 'synthetic admin pw', 'synthetic admin pw'],
      true,
    );
    await expect(
      runCreateAdmin({
        io: dup.io,
        createAdmin: vi.fn().mockRejectedValue(new DuplicateEmailError()),
      }),
    ).resolves.toBe(1);
    expect(dup.written()).toContain('already exists');
  });

  it('aborts on an empty email without prompting for a password', async () => {
    const { io, written } = makeIo(['   '], true);
    const createAdmin = vi.fn();
    await expect(runCreateAdmin({ io, createAdmin })).resolves.toBe(1);
    expect(written()).toContain('email is required');
    expect(createAdmin).not.toHaveBeenCalled();
  });
});
