import { describe, expect, it, vi } from 'vitest';

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((location: string) => {
    throw new Error(`NEXT_REDIRECT:${location}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect }));

import Home from './page';

describe('Home (root route)', () => {
  it('redirects to the dashboard', () => {
    expect(() => Home()).toThrow('NEXT_REDIRECT:/dashboard');
    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });
});
