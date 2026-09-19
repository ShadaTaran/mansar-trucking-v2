import { MANSAR_PACKAGE_PROBE } from '@mansar/types';
import { render, screen } from '@testing-library/react-native';

import App from '../App';

describe('App (scaffold screen)', () => {
  it('identifies the application', async () => {
    await render(<App />);

    expect(
      screen.getByText('Mansar Trucking Management System v2'),
    ).toBeOnTheScreen();
    expect(screen.getByText('Driver Mobile')).toBeOnTheScreen();
    expect(screen.getByText('Development scaffold')).toBeOnTheScreen();
  });

  it('renders the @mansar/types workspace probe', async () => {
    await render(<App />);

    expect(MANSAR_PACKAGE_PROBE).toBe('mansar-workspace-ok');
    expect(screen.getByText(MANSAR_PACKAGE_PROBE)).toBeOnTheScreen();
  });
});
