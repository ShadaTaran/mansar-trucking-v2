# 0007. Browser BFF authentication

Status: Accepted

## Context

The admin web app runs in browsers, where a leaked token is the main risk.
The API (ADR 0006) issues a 10-minute JWT and a rotating refresh token and
remains the only authentication authority. The browser must be able to use
those credentials without JavaScript ever holding them, without a second
session store, and without cross-site cookies or CORS.

## Decision

- **Topology**: browser → Next.js (same origin) → Nest API. The browser
  talks only to `/api/*` routes served by Next; Next calls the API
  server-side at `API_INTERNAL_URL`. Nest sets no cookies and stays the
  sole authority; Next keeps **no session database and no signing key**.
- **Custody**: the access token lives in the HttpOnly cookie `mansar_at`
  (Path=/), the refresh token in the HttpOnly cookie `mansar_rt`
  (**Path=/api/auth**). Both are SameSite=Lax, host-only (no Domain), Secure
  outside local development, with Max-Age taken from the API's lifetimes.
  Browser JavaScript never receives either token; `/api/auth/login` returns
  only the public user and `/api/auth/refresh` returns 204.
- **Admin only**: a successful API login for a non-ADMIN role sets no cookies,
  best-effort revokes the new refresh session, and answers 403.
- **Origin check**: every unsafe `/api/*` request (POST/PUT/PATCH/DELETE,
  including login) must carry `Origin` equal to `WEB_ORIGIN`, and
  `Sec-Fetch-Site`, when present, must be `same-origin`. No CSRF token.
- **Refresh coordination is client-side**: no route refreshes on the
  server's behalf. `authenticatedFetch` retries a 401 exactly once after a
  refresh serialized under the Web Lock `mansar-auth-refresh` (probe
  `/api/auth/me` first, refresh only if still 401) and single-flighted per
  tab; without Web Locks only the per-tab guard applies.
- **Generic proxy**: `/api/backend/<path>` forwards to
  `API_INTERNAL_URL/<path>` with the bearer from `mansar_at`, validated path
  segments, an allow-list of headers, no browser Cookie/Authorization, no
  upstream Set-Cookie, and no access to the API's `/auth/*` routes.
- **Upstream hygiene**: every browser-facing BFF response is
  `Cache-Control: no-store` (upstream cache directives are never relayed),
  and no server-to-API request follows a redirect — a 3xx from the API is an
  invalid response (502), so `API_INTERNAL_URL` is the only host ever
  contacted.
- **Routing consequence**: because `mansar_rt` is scoped to `/api/auth`, page
  requests cannot see whether a session is refreshable. Protected pages are
  therefore never redirected to `/login` on a missing access cookie; the
  client `AuthBoundary` asks the BFF (which may refresh) and redirects only
  when that fails. `proxy.ts` performs a single UX-only redirect
  (`/login` → `/dashboard` when an access cookie exists).

## Consequences

- XSS cannot exfiltrate tokens; it can still drive same-origin requests
  while the page is open, which a later CSP hardening stage addresses.
- Two tabs refreshing concurrently on a browser without Web Locks may trip
  the API's fail-closed reuse detection and force a new login.
- The BFF is stateless and horizontally scalable; every decision about
  session validity is made by the API.
- Local development runs over plain HTTP, so `Secure` is disabled only when
  `NODE_ENV=development`; every other environment requires HTTPS.
