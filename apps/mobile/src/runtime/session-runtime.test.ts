import { createAuthenticatedFetch } from '../auth/authenticated-fetch';
import { flush } from '../test/fake-auth-api';

import {
  getProcessSessionManager,
  resetProcessSessionManagerForTests,
} from './session-runtime';

/**
 * The process session manager, on Jest.
 *
 * One thing is being proved, and it is the single most dangerous property in
 * this redesign: whoever asks — the React tree, or a Headless task running with
 * no React tree at all — gets the *same object*. Two managers would mean two
 * single-flight rotation slots over one persisted refresh token, both could
 * present it, and the second presentation would look exactly like a stolen
 * replay. Reuse detection would then revoke the whole token family.
 *
 * No real network and no real keychain: `fetch` is a recording stub and the
 * keychain is the repository's manual mock. Synthetic identities only, and no
 * token value is ever asserted as a secret — only that one rotation happened.
 */

jest.mock('react-native-keychain');

const { __keychainFake: keychain } = jest.requireMock<
  typeof import('../../__mocks__/react-native-keychain')
>('react-native-keychain');
const { __mansarConfigFake: nativeConfig } = jest.requireMock<
  typeof import('../specs/__mocks__/NativeMansarConfig')
>('../specs/NativeMansarConfig');

const DRIVER = {
  id: '019a0000-0000-7000-8000-00000000d001',
  email: 'driver@example.test',
  role: 'DRIVER',
};

const tokenBody = (n: number) => ({
  accessToken: `synthetic.access.${n}`,
  accessExpiresIn: 600,
  refreshToken: `synthetic-refresh-${n}`,
  refreshExpiresAt: '2026-10-20T00:00:00.000Z',
});

interface Wire {
  readonly url: string;
  readonly authorization: string | undefined;
}

let wire: Wire[];
let rotations: number;

/**
 * Answers the two auth routes and one protected route.
 *
 * The protected route refuses the first access token and accepts the second,
 * which is what forces a rotation; `rotations` counts how many the server was
 * actually asked for.
 */
function stubFetch(): void {
  rotations = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    wire.push({ url, authorization: headers.authorization });
    const json = (status: number, body: unknown) => ({
      status,
      text: async () => JSON.stringify(body),
    });
    if (url.endsWith('/auth/login')) {
      return json(200, { ...tokenBody(1), user: DRIVER });
    }
    if (url.endsWith('/auth/refresh')) {
      rotations += 1;
      return json(200, tokenBody(2));
    }
    return json(
      headers.authorization === 'Bearer synthetic.access.2' ? 200 : 401,
      {},
    );
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  keychain.reset();
  nativeConfig.reset();
  resetProcessSessionManagerForTests();
  wire = [];
  stubFetch();
});

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('getProcessSessionManager', () => {
  it('returns the identical instance to every caller', () => {
    const fromApp = getProcessSessionManager();
    const fromHeadlessTask = getProcessSessionManager();

    expect(fromApp).not.toBeNull();
    // Object identity, not equality: equal managers would still be two
    // rotation domains.
    expect(fromHeadlessTask).toBe(fromApp);
  });

  it('rotates once when the app and a background task both hit 401', async () => {
    const session = getProcessSessionManager()!;
    await session.bootstrap();
    await session.login('driver@example.test', 'synthetic password value');
    // Two transports, standing for the React tree and the Headless task, over
    // the one manager they both resolve to.
    const foreground = createAuthenticatedFetch(session);
    const background = createAuthenticatedFetch(getProcessSessionManager()!);

    const [a, b] = await Promise.all([
      foreground('https://api.example.test/driver/trips'),
      background('https://api.example.test/driver/trips/x/location-samples'),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // The whole point of the singleton: one rotation, one stored token.
    expect(rotations).toBe(1);
    expect(keychain.entries.size).toBe(1);
    expect(session.getState()).toEqual({
      status: 'authenticated',
      user: DRIVER,
    });
  });

  it('fails closed when the build has no endpoint', () => {
    nativeConfig.apiBaseUrl = '';
    resetProcessSessionManagerForTests();

    expect(getProcessSessionManager()).toBeNull();
  });

  it('does not retry a fail-closed build into existence', () => {
    nativeConfig.apiBaseUrl = '';
    resetProcessSessionManagerForTests();
    expect(getProcessSessionManager()).toBeNull();

    // A later call must not quietly pick up a changed constant: the refusal
    // was a decision, and a release build has no endpoint to find.
    nativeConfig.apiBaseUrl = 'https://api.example.test';

    expect(getProcessSessionManager()).toBeNull();
  });

  it('refuses a plain-HTTP public origin rather than trusting it', () => {
    nativeConfig.apiBaseUrl = 'http://api.example.test';
    resetProcessSessionManagerForTests();

    expect(getProcessSessionManager()).toBeNull();
  });

  it('builds a new instance only after an explicit test reset', () => {
    const first = getProcessSessionManager();
    resetProcessSessionManagerForTests();
    const second = getProcessSessionManager();

    expect(second).not.toBe(first);
  });

  it('sends no request merely by existing', async () => {
    getProcessSessionManager();
    await flush();

    // Construction is not a bootstrap: nothing reaches the network until the
    // app asks.
    expect(wire).toEqual([]);
  });
});
