import { getApiBaseUrl, LOCAL_HTTP_HOSTS, resolveApiBaseUrl } from './api';

const { __mansarConfigFake: native } = jest.requireMock<
  typeof import('../specs/__mocks__/NativeMansarConfig')
>('../specs/NativeMansarConfig');

const DEBUG_URL = 'http://10.0.2.2:3001';
const STAGING_URL = 'https://mansar-api-staging.up.railway.app';

afterEach(() => {
  native.reset();
});

describe('resolveApiBaseUrl', () => {
  it('accepts the exact debug (emulator → host) endpoint', () => {
    expect(resolveApiBaseUrl(DEBUG_URL)).toBe(DEBUG_URL);
  });

  it('accepts the exact staging HTTPS endpoint', () => {
    expect(resolveApiBaseUrl(STAGING_URL)).toBe(STAGING_URL);
  });

  it('accepts plain HTTP only for the local development hosts', () => {
    expect([...LOCAL_HTTP_HOSTS].sort()).toEqual([
      '10.0.2.2',
      '127.0.0.1',
      'localhost',
    ]);
    expect(resolveApiBaseUrl('http://127.0.0.1:3001')).toBe(
      'http://127.0.0.1:3001',
    );
    expect(resolveApiBaseUrl('http://localhost:3001')).toBe(
      'http://localhost:3001',
    );
    expect(resolveApiBaseUrl('http://mansar-api-staging.up.railway.app')).toBe(
      null,
    );
    expect(resolveApiBaseUrl('http://192.168.1.10:3001')).toBeNull();
    expect(resolveApiBaseUrl('http://example.test')).toBeNull();
  });

  it('normalises case and a single trailing slash, keeps an explicit port', () => {
    expect(
      resolveApiBaseUrl('HTTPS://Mansar-API-Staging.up.railway.app/'),
    ).toBe(STAGING_URL);
    expect(resolveApiBaseUrl('https://api.example.test:8443')).toBe(
      'https://api.example.test:8443',
    );
    expect(resolveApiBaseUrl(`  ${STAGING_URL}  `)).toBe(STAGING_URL);
  });

  it.each([
    ['empty (release)', ''],
    ['whitespace', '   '],
    ['not a url', 'mansar-api-staging.up.railway.app'],
    ['other scheme', 'ftp://mansar-api-staging.up.railway.app'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['credentials', 'https://user:secret@mansar-api-staging.up.railway.app'],
    ['path', 'https://mansar-api-staging.up.railway.app/auth'],
    ['double slash path', 'https://mansar-api-staging.up.railway.app//'],
    ['query', 'https://mansar-api-staging.up.railway.app?x=1'],
    ['fragment', 'https://mansar-api-staging.up.railway.app#x'],
    ['port out of range', 'https://api.example.test:70000'],
    ['port zero', 'https://api.example.test:0'],
    ['leading dot host', 'https://.example.test'],
    ['space inside', 'https://api.example .test'],
  ])('rejects %s', (_label, value) => {
    expect(resolveApiBaseUrl(value)).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(resolveApiBaseUrl(null)).toBeNull();
    expect(resolveApiBaseUrl(undefined)).toBeNull();
  });
});

describe('getApiBaseUrl', () => {
  it('reads the debug build value from the native module', () => {
    expect(getApiBaseUrl()).toBe(DEBUG_URL);
  });

  it('reads the staging build value', () => {
    native.apiBaseUrl = STAGING_URL;
    expect(getApiBaseUrl()).toBe(STAGING_URL);
  });

  it('resolves to null for the empty release value', () => {
    native.apiBaseUrl = '';
    expect(getApiBaseUrl()).toBeNull();
  });
});
