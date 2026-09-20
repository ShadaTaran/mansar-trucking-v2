import * as Keychain from 'react-native-keychain';

/**
 * Custody of the one secret the driver app persists: the refresh token.
 *
 * Backed by react-native-keychain on Android: the value is AES-GCM encrypted
 * with a key that lives in the Android Keystore, and the ciphertext is kept
 * in app-private storage owned by the library. Nothing else is ever written
 * here (no access token, password, email or user record), and no other
 * module touches the Keychain. Biometric gating is deliberately not used.
 */

/** Deterministic, Mansar-owned service id isolating this entry from any other. */
export const REFRESH_TOKEN_SERVICE = 'com.mansar.driver.auth.refresh';

// The library requires a non-empty "username"; it is a fixed label, not data.
const ENTRY_LABEL = 'refresh-token';

export interface AuthSecretStore {
  /** The stored refresh token, or null when none is stored. */
  readRefreshToken(): Promise<string | null>;
  /** Replaces the stored refresh token; rejects when it could not be secured. */
  writeRefreshToken(token: string): Promise<void>;
  /** Removes the stored refresh token; a no-op when none exists. */
  clearRefreshToken(): Promise<void>;
}

/** Raised when the platform could not secure or clear the token. */
export class SecureStorageError extends Error {
  constructor(operation: 'read' | 'write' | 'clear') {
    // Fixed text only: the platform's own message could describe key material.
    super(`secure storage ${operation} failed`);
    this.name = 'SecureStorageError';
  }
}

const WRITE_OPTIONS: Keychain.SetOptions = {
  service: REFRESH_TOKEN_SERVICE,
  // Keystore-backed AES-GCM without a user-presence requirement.
  storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
  // Refuse anything weaker than a Keystore-held key (hardware when available).
  securityLevel: Keychain.SECURITY_LEVEL.SECURE_SOFTWARE,
};

const READ_OPTIONS: Keychain.GetOptions = { service: REFRESH_TOKEN_SERVICE };

export function createKeychainSecretStore(): AuthSecretStore {
  return {
    async readRefreshToken() {
      let entry: false | Keychain.UserCredentials;
      try {
        entry = await Keychain.getGenericPassword(READ_OPTIONS);
      } catch {
        throw new SecureStorageError('read');
      }
      if (!entry || entry.password.length === 0) {
        return null;
      }
      return entry.password;
    },

    async writeRefreshToken(token) {
      if (token.length === 0) {
        throw new SecureStorageError('write');
      }
      let result: false | Keychain.Result;
      try {
        result = await Keychain.setGenericPassword(
          ENTRY_LABEL,
          token,
          WRITE_OPTIONS,
        );
      } catch {
        throw new SecureStorageError('write');
      }
      if (result === false) {
        throw new SecureStorageError('write');
      }
    },

    async clearRefreshToken() {
      let cleared: boolean;
      try {
        cleared = await Keychain.resetGenericPassword(READ_OPTIONS);
      } catch {
        throw new SecureStorageError('clear');
      }
      if (!cleared) {
        throw new SecureStorageError('clear');
      }
    },
  };
}
