/**
 * The one way the browser ends its session: the BFF clears both HttpOnly
 * cookies and best-effort revokes the refresh session upstream. Callers
 * always navigate to /login afterwards, whatever the response was, so a
 * failed request can never leave the user looking signed in.
 */
export async function requestLogout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch {
    // The browser is signed out either way; nothing to report.
  }
}
