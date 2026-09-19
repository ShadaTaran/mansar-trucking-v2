import { MANSAR_PACKAGE_PROBE } from '@mansar/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import Home from './page';

describe('Home (scaffold page)', () => {
  it('identifies the application', () => {
    render(<Home />);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Mansar Trucking Management System v2',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Admin Web')).toBeInTheDocument();
  });

  it('renders the @mansar/types workspace probe', () => {
    render(<Home />);

    expect(MANSAR_PACKAGE_PROBE).toBe('mansar-workspace-ok');
    expect(screen.getByText(MANSAR_PACKAGE_PROBE)).toBeInTheDocument();
  });
});
