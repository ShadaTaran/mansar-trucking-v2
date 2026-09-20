/**
 * Jest stand-in for `react-native-keychain`: an in-memory, per-service map
 * with the same promise-based surface the app uses. No Android Keystore is
 * involved under Jest. Tests can inject failures and inspect what was stored
 * through `__keychainFake`.
 *
 * Operations settle in call order (a FIFO queue), mirroring the native
 * module's serialised execution, so ordering-sensitive tests are meaningful.
 */

export enum STORAGE_TYPE {
  AES_CBC = 'KeystoreAESCBC',
  AES_GCM_NO_AUTH = 'KeystoreAESGCM_NoAuth',
  AES_GCM = 'KeystoreAESGCM',
  RSA = 'KeystoreRSAECB',
}

export enum SECURITY_LEVEL {
  SECURE_SOFTWARE = 0,
  SECURE_HARDWARE = 1,
  ANY = 2,
}

export interface BaseOptions {
  service?: string;
}
export interface SetOptions extends BaseOptions {
  storage?: STORAGE_TYPE;
  securityLevel?: SECURITY_LEVEL;
}
export type GetOptions = BaseOptions;
export interface Result {
  service: string;
  storage: STORAGE_TYPE;
}
export interface UserCredentials extends Result {
  username: string;
  password: string;
}

interface Entry {
  username: string;
  password: string;
  storage: STORAGE_TYPE;
  securityLevel: SECURITY_LEVEL | undefined;
}

interface Fake {
  entries: Map<string, Entry>;
  failNext: { get?: boolean; set?: boolean | 'false'; reset?: boolean };
  calls: Array<{ op: 'get' | 'set' | 'reset'; service: string }>;
  /**
   * Runs once while the next write executes, before the entry lands; a
   * returned promise delays that write (and everything queued behind it).
   * For deterministic race tests.
   */
  onSet: (() => void | Promise<void>) | null;
  /** Runs once while the next read executes, before it resolves. */
  onGet: (() => void | Promise<void>) | null;
  reset(): void;
}

export const __keychainFake: Fake = {
  entries: new Map(),
  failNext: {},
  calls: [],
  onSet: null,
  onGet: null,
  reset() {
    this.entries = new Map();
    this.failNext = {};
    this.calls = [];
    this.onSet = null;
    this.onGet = null;
  },
};

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => T | Promise<T>): Promise<T> {
  const next = queue.then(work);
  queue = next.catch(() => undefined);
  return next;
}

async function runHook(slot: 'onSet' | 'onGet'): Promise<void> {
  const hook = __keychainFake[slot];
  if (hook) {
    __keychainFake[slot] = null;
    await hook();
  }
}

const DEFAULT_SERVICE = 'com.mansar.driver';

export function setGenericPassword(
  username: string,
  password: string,
  options: SetOptions = {},
): Promise<false | Result> {
  const service = options.service ?? DEFAULT_SERVICE;
  return enqueue(async () => {
    __keychainFake.calls.push({ op: 'set', service });
    if (__keychainFake.failNext.set === true) {
      __keychainFake.failNext.set = undefined;
      throw new Error('E_CRYPTO_FAILED');
    }
    if (__keychainFake.failNext.set === 'false') {
      __keychainFake.failNext.set = undefined;
      return false;
    }
    if (username.length === 0 || password.length === 0) {
      throw new Error('E_EMPTY_PARAMETERS');
    }
    const storage = options.storage ?? STORAGE_TYPE.AES_GCM_NO_AUTH;
    await runHook('onSet');
    __keychainFake.entries.set(service, {
      username,
      password,
      storage,
      securityLevel: options.securityLevel,
    });
    return { service, storage };
  });
}

export function getGenericPassword(
  options: GetOptions = {},
): Promise<false | UserCredentials> {
  const service = options.service ?? DEFAULT_SERVICE;
  return enqueue(async () => {
    __keychainFake.calls.push({ op: 'get', service });
    if (__keychainFake.failNext.get) {
      __keychainFake.failNext.get = undefined;
      throw new Error('E_CRYPTO_FAILED');
    }
    await runHook('onGet');
    const entry = __keychainFake.entries.get(service);
    if (!entry) {
      return false;
    }
    return {
      service,
      storage: entry.storage,
      username: entry.username,
      password: entry.password,
    };
  });
}

export function resetGenericPassword(
  options: BaseOptions = {},
): Promise<boolean> {
  const service = options.service ?? DEFAULT_SERVICE;
  return enqueue(() => {
    __keychainFake.calls.push({ op: 'reset', service });
    if (__keychainFake.failNext.reset) {
      __keychainFake.failNext.reset = undefined;
      throw new Error('E_KEYSTORE_ACCESS_ERROR');
    }
    __keychainFake.entries.delete(service);
    return true;
  });
}

export function hasGenericPassword(
  options: BaseOptions = {},
): Promise<boolean> {
  const service = options.service ?? DEFAULT_SERVICE;
  return enqueue(() => __keychainFake.entries.has(service));
}

export default {
  STORAGE_TYPE,
  SECURITY_LEVEL,
  setGenericPassword,
  getGenericPassword,
  resetGenericPassword,
  hasGenericPassword,
};
