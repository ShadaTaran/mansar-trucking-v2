import type { AuthSecretStore } from '../auth/auth-secret-store';

/**
 * An `AuthSecretStore` whose every operation stays pending until the test
 * settles it. Unlike the FIFO Keychain fake, it gives NO ordering or
 * atomicity guarantee — the same as the real platform store from the
 * session manager's point of view — so a test can choose the most harmful
 * settlement order and prove the manager survives it.
 *
 * Effects are applied when an operation is settled, not when it is issued.
 */

export type StoreOp = 'read' | 'write' | 'clear';

interface Pending {
  readonly id: number;
  readonly op: StoreOp;
  readonly token?: string;
  settle: () => void;
}

export interface ControlledSecretStore extends AuthSecretStore {
  /** Current stored value. */
  current(): string | null;
  /** Operations issued and not yet settled, oldest first. */
  pending(): ReadonlyArray<{ id: number; op: StoreOp; token?: string }>;
  /** Every operation ever issued, in issue order. */
  log(): ReadonlyArray<{ id: number; op: StoreOp; token?: string }>;
  /** Settles the oldest pending operation of the given kind. */
  settle(op: StoreOp): void;
  /**
   * Settles everything that is or becomes pending, in the most adversarial
   * order for a read/compare/clear implementation: reads before writes,
   * writes before clears, repeated until nothing is pending. Returns when
   * the store is quiescent.
   */
  drainAdversarially(): Promise<void>;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

export function createControlledSecretStore(
  initial: string | null = null,
): ControlledSecretStore {
  let value = initial;
  let nextId = 1;
  const pending: Pending[] = [];
  const log: Array<{ id: number; op: StoreOp; token?: string }> = [];

  function issue<T>(op: StoreOp, effect: () => T, token?: string): Promise<T> {
    const id = nextId;
    nextId += 1;
    log.push(token === undefined ? { id, op } : { id, op, token });
    return new Promise<T>((resolve) => {
      const entry: Pending = {
        id,
        op,
        ...(token === undefined ? {} : { token }),
        settle: () => resolve(effect()),
      };
      pending.push(entry);
    });
  }

  function settle(op: StoreOp): void {
    const index = pending.findIndex((entry) => entry.op === op);
    if (index === -1) {
      throw new Error(`no pending ${op} operation`);
    }
    const [entry] = pending.splice(index, 1);
    entry!.settle();
  }

  return {
    readRefreshToken: () => issue('read', () => value),
    writeRefreshToken: (token) =>
      issue(
        'write',
        () => {
          value = token;
        },
        token,
      ),
    clearRefreshToken: () =>
      issue('clear', () => {
        value = null;
      }),
    current: () => value,
    pending: () => pending.map(({ id, op, token }) => ({ id, op, token })),
    log: () => log,
    settle,
    async drainAdversarially() {
      for (;;) {
        await flushMicrotasks();
        if (pending.length === 0) {
          return;
        }
        for (const op of ['read', 'write', 'clear'] as const) {
          while (pending.some((entry) => entry.op === op)) {
            settle(op);
            await flushMicrotasks();
          }
        }
      }
    },
  };
}
