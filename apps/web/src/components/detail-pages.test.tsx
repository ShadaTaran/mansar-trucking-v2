import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/drivers',
}));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { DriverDetail } from './driver-detail';
import { VehicleDetail } from './vehicle-detail';

const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';

const DRIVER = {
  id: DRIVER_ID,
  fullName: 'Synthetic Driver',
  phone: '+63 900 000 0000',
  licenceNumber: 'SYN-0001',
  licenceExpiry: '2027-03-31',
  status: 'ACTIVE',
  notes: '',
  user: {
    id: '019a0000-0000-7000-8000-000000000001',
    email: 'driver@example.test',
    isActive: true,
  },
  createdAt: '2026-09-01T08:30:00.000Z',
  updatedAt: '2026-09-02T09:45:00.000Z',
};

const VEHICLE = {
  id: VEHICLE_ID,
  plateNumber: 'SYN 0001',
  make: 'Synthetic',
  model: 'Hauler',
  year: 2020,
  status: 'IN_MAINTENANCE',
  currentOdometer: 125000,
  notes: '',
  createdAt: '2026-09-01T08:30:00.000Z',
  updatedAt: '2026-09-02T09:45:00.000Z',
};

function installFetch(handler: (url: string) => Response) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      return handler(url);
    }),
  );
  return urls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

const EMPTY_MAINTENANCE_PAGE = { items: [], page: 1, pageSize: 25, total: 0 };

/**
 * VehicleDetail now embeds the maintenance section, so the two requests it
 * makes have to be told apart. A single catch-all would hand a Vehicle object
 * to the maintenance parser, which correctly refuses it — a failure that would
 * look like a bug in this component rather than in the mock.
 */
const vehicleScene = (url: string) =>
  url.startsWith('/api/backend/maintenance')
    ? json(200, EMPTY_MAINTENANCE_PAGE)
    : json(200, VEHICLE);

beforeEach(() => {
  resetAuthenticatedFetchForTests();
  Object.defineProperty(navigator, 'locks', {
    value: undefined,
    configurable: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DriverDetail', () => {
  it('loads the record and offers editing, lifecycle and linking', async () => {
    installFetch(() => json(200, DRIVER));
    render(<DriverDetail driverId={DRIVER_ID} />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading driver…');

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Synthetic Driver',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('2026-09-01 08:30 UTC')).toBeInTheDocument();
    expect(screen.getByText('2026-09-02 09:45 UTC')).toBeInTheDocument();
    expect(screen.getByLabelText('Full name')).toHaveValue('Synthetic Driver');
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeEnabled();
    expect(
      screen.getByText('driver@example.test — account active'),
    ).toBeInTheDocument();
  });

  it('shows a clear not-found state', async () => {
    installFetch(() =>
      json(404, { statusCode: 404, message: 'driver_not_found' }),
    );
    render(<DriverDetail driverId={DRIVER_ID} />);

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Driver not found',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Back to drivers' }),
    ).toHaveAttribute('href', '/drivers');
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
  });

  it('shows a failure state that is not the not-found state', async () => {
    installFetch(() => json(500, { statusCode: 500 }));
    render(<DriverDetail driverId={DRIVER_ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again shortly.',
    );
    expect(screen.queryByText('Driver not found')).toBeNull();
  });
});

describe('VehicleDetail', () => {
  it('loads the record and offers editing and the status control', async () => {
    installFetch(vehicleScene);
    render(<VehicleDetail vehicleId={VEHICLE_ID} />);

    expect(screen.getAllByRole('status')[0]).toHaveTextContent(
      'Loading vehicle…',
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'SYN 0001' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Current odometer')).toHaveValue(125000);
    expect(screen.getByLabelText('Change status to')).toHaveValue(
      'IN_MAINTENANCE',
    );
    expect(screen.getByText('2026-09-01 08:30 UTC')).toBeInTheDocument();
  });

  it('shows the maintenance section once the vehicle has loaded', async () => {
    const urls = installFetch(vehicleScene);
    render(<VehicleDetail vehicleId={VEHICLE_ID} />);

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Maintenance' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Recording maintenance does not change the vehicle's operational status.",
      ),
    ).toBeInTheDocument();
    // Scoped to this vehicle, with no status filter: the vehicle's page shows
    // its whole history, not just the outstanding work.
    expect(urls).toContain(
      `/api/backend/maintenance?vehicleId=${VEHICLE_ID}&page=1&pageSize=25`,
    );
    expect(urls.some((url) => url.includes('status='))).toBe(false);
  });

  it('offers maintenance entry even though this vehicle is IN_MAINTENANCE', async () => {
    // Vehicle.status is not an eligibility input for maintenance (ADR 0010).
    installFetch(vehicleScene);
    render(<VehicleDetail vehicleId={VEHICLE_ID} />);

    expect(
      await screen.findByRole('button', { name: 'Add maintenance' }),
    ).toBeEnabled();
  });

  it('shows a clear not-found state', async () => {
    installFetch(() =>
      json(404, { statusCode: 404, message: 'vehicle_not_found' }),
    );
    render(<VehicleDetail vehicleId={VEHICLE_ID} />);

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Vehicle not found',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Back to vehicles' }),
    ).toHaveAttribute('href', '/vehicles');
  });
});
