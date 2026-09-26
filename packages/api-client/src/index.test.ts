import { describe, expect, it } from 'vitest';

import {
  API_CLIENT_PROBE,
  createApiClientConfig,
  createAuthApi,
  isTripStatus,
  requestCreated,
  requestJson,
  requestNoContent,
} from './index.js';

describe('@mansar/api-client', () => {
  it('consumes @mansar/types across the workspace boundary', () => {
    expect(API_CLIENT_PROBE).toBe('mansar-workspace-ok:api-client');
  });

  it('recognises locked trip states and rejects unknown values', () => {
    expect(isTripStatus('VERIFIED')).toBe(true);
    expect(isTripStatus('verified')).toBe(false);
    expect(isTripStatus(42)).toBe(false);
  });

  it('exposes the transport core and the auth operations from one entry point', () => {
    const auth = createAuthApi(
      createApiClientConfig('https://api.example.test'),
    );
    expect(Object.keys(auth).sort()).toEqual([
      'login',
      'logout',
      'logoutAll',
      'me',
      'refresh',
    ]);
  });

  it('exposes one request helper per success-status contract', () => {
    // 200, 201 and 204 are three different endpoint contracts, so the entry
    // point offers three functions rather than one with a status argument.
    expect(typeof requestJson).toBe('function');
    expect(typeof requestCreated).toBe('function');
    expect(typeof requestNoContent).toBe('function');
  });
});
