import * as Keychain from 'react-native-keychain';

import {
  createKeychainSecretStore,
  REFRESH_TOKEN_SERVICE,
  SecureStorageError,
} from './auth-secret-store';

jest.mock('react-native-keychain');

// The mock module exposes its in-memory state for assertions.
const { __keychainFake: fake } = jest.requireMock<
  typeof import('../../__mocks__/react-native-keychain')
>('react-native-keychain');

const TOKEN = 'synthetic-refresh-token-for-store-test';

beforeEach(() => {
  fake.reset();
});

describe('createKeychainSecretStore', () => {
  it('runs against the Jest mock, never a real Keystore', () => {
    expect(jest.isMockFunction(Keychain.setGenericPassword)).toBe(false);
    expect(fake.entries).toBeInstanceOf(Map);
    expect(typeof Keychain.getGenericPassword).toBe('function');
  });

  it('reads null when nothing is stored', async () => {
    const store = createKeychainSecretStore();
    await expect(store.readRefreshToken()).resolves.toBeNull();
    expect(fake.calls).toEqual([{ op: 'get', service: REFRESH_TOKEN_SERVICE }]);
  });

  it('writes only under the Mansar service with Keystore-backed AES-GCM', async () => {
    const store = createKeychainSecretStore();
    await store.writeRefreshToken(TOKEN);

    expect([...fake.entries.keys()]).toEqual([REFRESH_TOKEN_SERVICE]);
    const entry = fake.entries.get(REFRESH_TOKEN_SERVICE)!;
    expect(entry.password).toBe(TOKEN);
    expect(entry.username).toBe('refresh-token');
    expect(entry.storage).toBe(Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH);
    expect(entry.securityLevel).toBe(Keychain.SECURITY_LEVEL.SECURE_SOFTWARE);
    expect(REFRESH_TOKEN_SERVICE).toBe('com.mansar.driver.auth.refresh');
  });

  it('round-trips and clears the token', async () => {
    const store = createKeychainSecretStore();
    await store.writeRefreshToken(TOKEN);
    await expect(store.readRefreshToken()).resolves.toBe(TOKEN);
    await store.clearRefreshToken();
    await expect(store.readRefreshToken()).resolves.toBeNull();
    expect(fake.entries.size).toBe(0);
  });

  it('replaces a previous token instead of accumulating entries', async () => {
    const store = createKeychainSecretStore();
    await store.writeRefreshToken(`${TOKEN}-1`);
    await store.writeRefreshToken(`${TOKEN}-2`);
    expect(fake.entries.size).toBe(1);
    await expect(store.readRefreshToken()).resolves.toBe(`${TOKEN}-2`);
  });

  it('refuses to store an empty token', async () => {
    const store = createKeychainSecretStore();
    await expect(store.writeRefreshToken('')).rejects.toBeInstanceOf(
      SecureStorageError,
    );
    expect(fake.calls).toEqual([]);
  });

  it('maps platform failures to SecureStorageError without detail', async () => {
    const store = createKeychainSecretStore();

    fake.failNext.set = true;
    const writeError = await store
      .writeRefreshToken(TOKEN)
      .catch((e: unknown) => e);
    expect(writeError).toBeInstanceOf(SecureStorageError);
    expect((writeError as Error).message).toBe('secure storage write failed');

    fake.failNext.set = 'false';
    await expect(store.writeRefreshToken(TOKEN)).rejects.toBeInstanceOf(
      SecureStorageError,
    );

    fake.failNext.get = true;
    await expect(store.readRefreshToken()).rejects.toBeInstanceOf(
      SecureStorageError,
    );

    fake.failNext.reset = true;
    await expect(store.clearRefreshToken()).rejects.toBeInstanceOf(
      SecureStorageError,
    );
  });

  it('clearing when nothing is stored is not an error', async () => {
    const store = createKeychainSecretStore();
    await expect(store.clearRefreshToken()).resolves.toBeUndefined();
  });
});
