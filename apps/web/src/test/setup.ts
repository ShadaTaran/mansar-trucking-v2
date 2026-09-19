import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest globals are disabled, so Testing Library cannot register its own
// automatic cleanup; unmount rendered trees between tests explicitly.
afterEach(() => {
  cleanup();
});
