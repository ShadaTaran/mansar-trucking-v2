import { describe, expect, it } from 'vitest';

import { normalizeEmail } from './email.js';

describe('normalizeEmail', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  driver@example.test \n')).toBe(
      'driver@example.test',
    );
  });

  it('lowercases ASCII with the locale-independent algorithm', () => {
    expect(normalizeEmail('Admin.User@Example.TEST')).toBe(
      'admin.user@example.test',
    );
    // Dotted capital I must not become the Turkish dotless form.
    expect(normalizeEmail('I@example.test')).toBe('i@example.test');
  });

  it('applies NFC so composed and decomposed forms are equal', () => {
    const composed = 'josé@example.test';
    const decomposed = 'josé@example.test';
    expect(normalizeEmail(decomposed)).toBe(composed);
    expect(normalizeEmail(composed)).toBe(composed);
  });

  it('is idempotent', () => {
    const once = normalizeEmail('  José.Driver@Example.Test ');
    expect(normalizeEmail(once)).toBe(once);
  });
});
