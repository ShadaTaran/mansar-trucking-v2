// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { config, proxy } from './proxy';

describe('proxy.ts (UX-only optimistic redirect)', () => {
  it('runs only on /login', () => {
    expect(config.matcher).toBe('/login');
  });

  it('sends a visitor with an access cookie from /login to /dashboard', () => {
    const response = proxy(
      new NextRequest('http://localhost:3000/login', {
        headers: { cookie: 'mansar_at=aaa.bbb.ccc' },
      }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/dashboard',
    );
  });

  it('lets /login through without an access cookie (never redirects to /login itself)', () => {
    const response = proxy(new NextRequest('http://localhost:3000/login'));
    expect(response.headers.get('location')).toBeNull();
    expect(response.status).toBe(200);
  });
});
