import { createKeychainSecretStore } from './auth-secret-store';
import {
  createAuthenticatedFetch,
  MAX_AUTOMATIC_RETRIES,
  NotAuthenticatedError,
} from './authenticated-fetch';
import { createSessionManager, type SessionManager } from './session-manager';
import {
  createFakeAuthApi,
  deferred,
  flush,
  httpError,
  loginResult,
  tokens,
  type FakeAuthApi,
} from '../test/fake-auth-api';

jest.mock('react-native-keychain');

const { __keychainFake: keychain } = jest.requireMock<
  typeof import('../../__mocks__/react-native-keychain')
>('react-native-keychain');

interface Sent {
  url: string;
  method: string;
  authorization: string | undefined;
  body: unknown;
}

let api: FakeAuthApi;
let session: SessionManager;
let sent: Sent[];
let responder: (request: Sent) => Promise<Response> | Response;

function response(status: number): Response {
  return { status } as Response;
}

const rawFetch: typeof fetch = async (input, init) => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const request: Sent = {
    url: String(input),
    method: init?.method ?? 'GET',
    authorization: headers.authorization,
    body: init?.body,
  };
  sent.push(request);
  return responder(request);
};

beforeEach(async () => {
  keychain.reset();
  sent = [];
  responder = () => response(200);
  api = createFakeAuthApi();
  session = createSessionManager({
    authApi: api,
    secretStore: createKeychainSecretStore(),
  });
  await session.bootstrap();
  api.login.mockResolvedValueOnce(loginResult(1));
  await session.login('driver@example.test', 'synthetic password value');
});

describe('createAuthenticatedFetch', () => {
  it('sends the in-memory access token as a bearer and returns non-401 responses as-is', async () => {
    const authenticatedFetch = createAuthenticatedFetch(session, rawFetch);
    responder = () => response(200);

    const result = await authenticatedFetch('https://api.example.test/trips', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });

    expect(result.status).toBe(200);
    expect(sent).toEqual([
      {
        url: 'https://api.example.test/trips',
        method: 'POST',
        authorization: 'Bearer synthetic.access.1',
        body: '{"a":1}',
      },
    ]);
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('refuses without a session instead of sending an unauthenticated request', async () => {
    await session.logout();
    const authenticatedFetch = createAuthenticatedFetch(session, rawFetch);
    await expect(
      authenticatedFetch('https://api.example.test/trips'),
    ).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(sent).toEqual([]);
  });

  it('on 401 refreshes once and retries exactly once with the new token', async () => {
    const authenticatedFetch = createAuthenticatedFetch(session, rawFetch);
    api.refresh.mockResolvedValueOnce(tokens(2));
    responder = (request) =>
      response(
        request.authorization === 'Bearer synthetic.access.2' ? 200 : 401,
      );

    const result = await authenticatedFetch('https://api.example.test/trips');

    expect(result.status).toBe(200);
    expect(sent.map((r) => r.authorization)).toEqual([
      'Bearer synthetic.access.1',
      'Bearer synthetic.access.2',
    ]);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(MAX_AUTOMATIC_RETRIES).toBe(1);
  });

  it('returns the second 401 without refreshing or retrying again', async () => {
    const authenticatedFetch = createAuthenticatedFetch(session, rawFetch);
    api.refresh.mockResolvedValueOnce(tokens(3));
    responder = () => response(401);

    const result = await authenticatedFetch('https://api.example.test/trips');

    expect(result.status).toBe(401);
    expect(sent).toHaveLength(2);
    expect(api.refresh).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one POST /auth/refresh when many requests hit 401 at once', async () => {
    const authenticatedFetch = createAuthenticatedFetch(session, rawFetch);
    const rotation = deferred<ReturnType<typeof tokens>>();
    api.refresh.mockReturnValueOnce(rotation.promise);
    responder = (request) =>
      response(
        request.authorization === 'Bearer synthetic.access.4' ? 200 : 401,
      );

    const requests = Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((name) =>
        authenticatedFetch(`https://api.example.test/${name}`),
      ),
    );
    await flush();
    expect(sent).toHaveLength(5);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.refresh).toHaveBeenCalledWith('synthetic-refresh-1');

    rotation.resolve(tokens(4));
    const results = await requests;

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    // Five originals with the old token, five retries with the new one.
    expect(
      sent.filter((r) => r.authorization === 'Bearer synthetic.access.1'),
    ).toHaveLength(5);
    expect(
      sent.filter((r) => r.authorization === 'Bearer synthetic.access.4'),
    ).toHaveLength(5);
    expect(sent).toHaveLength(10);
  });

  it('returns the 401 and ends the session when the refresh token is rejected', async () => {
    const authenticatedFetch = createAuthenticatedFetch(session, rawFetch);
    api.refresh.mockRejectedValueOnce(httpError(401, 'invalid_refresh_token'));
    responder = () => response(401);

    const result = await authenticatedFetch('https://api.example.test/trips');

    expect(result.status).toBe(401);
    expect(sent).toHaveLength(1);
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
    expect(session.getAccessToken()).toBeNull();
    expect(keychain.entries.size).toBe(0);
  });

  it('returns the 401 but keeps the session when the refresh was only unavailable', async () => {
    const authenticatedFetch = createAuthenticatedFetch(session, rawFetch);
    api.refresh.mockRejectedValueOnce(httpError(503, null));
    responder = () => response(401);

    const result = await authenticatedFetch('https://api.example.test/trips');

    expect(result.status).toBe(401);
    expect(sent).toHaveLength(1);
    expect(session.getState().status).toBe('authenticated');
  });

  it.each([
    ['400', httpError(400, null)],
    ['404', httpError(404, null)],
    ['429', httpError(429, null)],
    ['500', httpError(500, null)],
  ])(
    'a non-terminal refresh failure (%s) returns the 401 once, keeps the session and never loops',
    async (_label, failure) => {
      const authenticatedFetch = createAuthenticatedFetch(session, rawFetch);
      api.refresh.mockRejectedValueOnce(failure);
      responder = () => response(401);

      const result = await authenticatedFetch('https://api.example.test/trips');

      expect(result.status).toBe(401);
      expect(sent).toHaveLength(1);
      expect(api.refresh).toHaveBeenCalledTimes(1);
      expect(session.getState().status).toBe('authenticated');
      expect(keychain.entries.size).toBe(1);
    },
  );

  it('never places the token anywhere but the Authorization header', async () => {
    const authenticatedFetch = createAuthenticatedFetch(session, rawFetch);
    await authenticatedFetch('https://api.example.test/trips?page=1');
    const [request] = sent;
    expect(request!.url).not.toContain('synthetic');
    expect(String(request!.body)).not.toContain('synthetic');
  });
});
