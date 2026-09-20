// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getServerConfig,
  isSecureCookieEnvironment,
  parseApiInternalUrl,
  parseWebOrigin,
} from './config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseApiInternalUrl', () => {
  it('accepts http/https origins and normalizes a trailing slash', () => {
    expect(parseApiInternalUrl('http://127.0.0.1:3001')).toBe(
      'http://127.0.0.1:3001',
    );
    expect(parseApiInternalUrl('http://127.0.0.1:3001/')).toBe(
      'http://127.0.0.1:3001',
    );
    expect(parseApiInternalUrl('https://api.example.test')).toBe(
      'https://api.example.test',
    );
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['relative', '/api'],
    ['no scheme', '127.0.0.1:3001'],
    ['ftp', 'ftp://api.example.test'],
    ['credentials', 'http://user:pw@127.0.0.1:3001'],
    ['path', 'http://127.0.0.1:3001/v1'],
    ['query', 'http://127.0.0.1:3001/?x=1'],
    ['fragment', 'http://127.0.0.1:3001/#x'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseApiInternalUrl(value)).toThrow('API_INTERNAL_URL');
  });
});

describe('parseWebOrigin', () => {
  it('accepts a bare origin', () => {
    expect(parseWebOrigin('http://localhost:3000')).toBe(
      'http://localhost:3000',
    );
    expect(parseWebOrigin('https://admin.example.test/')).toBe(
      'https://admin.example.test',
    );
  });

  it.each([
    ['unset', undefined],
    ['path', 'http://localhost:3000/app'],
    ['credentials', 'http://a:b@localhost:3000'],
    ['query', 'http://localhost:3000?x'],
    ['ws', 'ws://localhost:3000'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseWebOrigin(value)).toThrow('WEB_ORIGIN');
  });
});

describe('getServerConfig / isSecureCookieEnvironment', () => {
  it('reads both values from the environment', () => {
    vi.stubEnv('API_INTERNAL_URL', 'http://127.0.0.1:3001/');
    vi.stubEnv('WEB_ORIGIN', 'http://localhost:3000/');
    expect(getServerConfig()).toEqual({
      apiInternalUrl: 'http://127.0.0.1:3001',
      webOrigin: 'http://localhost:3000',
    });
  });

  it('marks cookies Secure everywhere except development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(isSecureCookieEnvironment()).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    expect(isSecureCookieEnvironment()).toBe(true);
    vi.stubEnv('NODE_ENV', 'test');
    expect(isSecureCookieEnvironment()).toBe(true);
  });
});
