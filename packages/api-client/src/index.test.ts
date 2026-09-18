import { describe, expect, it } from 'vitest';

import {
  API_CLIENT_PROBE,
  createApiClientConfig,
  isTripStatus,
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

  it('strips trailing slashes from the base URL', () => {
    expect(createApiClientConfig('https://api.example.test///').baseUrl).toBe(
      'https://api.example.test',
    );
  });
});
