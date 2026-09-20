'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

/** Safe, user-facing text for each BFF outcome; nothing upstream is shown. */
export function loginErrorMessage(status: number, code: string): string {
  if (status === 401 && code === 'invalid_credentials') {
    return 'Incorrect email or password.';
  }
  if (status === 403 && code === 'account_inactive') {
    return 'This account is deactivated. Contact an administrator.';
  }
  if (status === 403) {
    return 'This sign-in is for administrators only.';
  }
  if (status === 429) {
    return 'Too many attempts. Please wait a minute and try again.';
  }
  if (status === 400) {
    return 'Please enter a valid email and password.';
  }
  return 'Sign-in is temporarily unavailable. Please try again shortly.';
}

/**
 * Email + password form posting to the same-origin BFF. The BFF fixes the
 * client type and keeps the tokens; nothing credential-like enters React
 * state beyond the typed password until submit.
 */
export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (response.status === 200) {
        setPassword('');
        router.replace('/dashboard');
        router.refresh();
        return;
      }
      let code = '';
      try {
        const body = (await response.json()) as { message?: unknown };
        code = typeof body.message === 'string' ? body.message : '';
      } catch {
        code = '';
      }
      setError(loginErrorMessage(response.status, code));
    } catch {
      setError(loginErrorMessage(502, ''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>Mansar Trucking</h1>
      <h2>Admin sign in</h2>
      <form onSubmit={submit} aria-busy={busy}>
        <p>
          <label htmlFor="email">Email</label>
          <br />
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </p>
        <p>
          <label htmlFor="password">Password</label>
          <br />
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </p>
        <p>
          <button type="submit" disabled={busy}>
            Sign in
          </button>
        </p>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </main>
  );
}
