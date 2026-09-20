import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { replace, refresh, router } = vi.hoisted(() => {
  const replace = vi.fn();
  const refresh = vi.fn();
  // One stable object, as Next provides; a fresh object per render would
  // re-run every effect that depends on the router.
  return { replace, refresh, router: { replace, refresh } };
});
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { LoginForm, loginErrorMessage } from './login-form';

const USER = {
  id: '019a0000-0000-7000-8000-000000000001',
  email: 'admin@example.test',
  role: 'ADMIN',
};

function installFetch(response: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'admin@example.test' },
  });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'synthetic password value' },
  });
  fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
  // Let the submit handler's fetch settle.
  await Promise.resolve();
}

beforeEach(() => {
  replace.mockReset();
  refresh.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginForm', () => {
  it('posts only email and password to the same-origin BFF and redirects on success', async () => {
    const fetchMock = installFetch(
      () => new Response(JSON.stringify({ user: USER }), { status: 200 }),
    );
    render(<LoginForm />);
    expect(screen.queryByLabelText(/client/i)).not.toBeInTheDocument();
    await fillAndSubmit();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'admin@example.test',
      password: 'synthetic password value',
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    expect(refresh).toHaveBeenCalled();
    // The typed password is dropped from state once the BFF accepted it, and
    // nothing token-like ever reaches the DOM.
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe(
      '',
    );
    expect(document.body.innerHTML).not.toMatch(
      /accessToken|refreshToken|mansar_/,
    );
  });

  it.each([
    [401, 'invalid_credentials', 'Incorrect email or password.'],
    [
      403,
      'account_inactive',
      'This account is deactivated. Contact an administrator.',
    ],
    [403, 'forbidden', 'This sign-in is for administrators only.'],
    [
      429,
      'too_many_requests',
      'Too many attempts. Please wait a minute and try again.',
    ],
    [
      502,
      'upstream_unavailable',
      'Sign-in is temporarily unavailable. Please try again shortly.',
    ],
  ])('shows a safe message for %s %s', async (status, code, message) => {
    installFetch(
      () =>
        new Response(JSON.stringify({ statusCode: status, message: code }), {
          status,
        }),
    );
    render(<LoginForm />);
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows the unavailable message when the network fails', async () => {
    installFetch(() => Promise.reject(new TypeError('offline')));
    render(<LoginForm />);
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'temporarily unavailable',
    );
  });

  it('maps codes without exposing them', () => {
    expect(
      loginErrorMessage(500, 'stack: at Object.<anonymous>'),
    ).not.toContain('stack');
    expect(loginErrorMessage(400, '')).toContain('valid email');
  });
});
