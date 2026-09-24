import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/trips',
}));

import type { Trip, TripStatus } from '@mansar/types';

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { TripAssignment } from './trip-assignment';

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const OTHER_DRIVER_ID = '019a0000-0000-7000-8000-00000000000b';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const OTHER_VEHICLE_ID = '019a0000-0000-7000-8000-00000000000c';

const driver = (
  id: string,
  fullName: string,
  licenceNumber: string,
  status = 'ACTIVE',
) => ({
  id,
  fullName,
  phone: '+63 900 000 0000',
  licenceNumber,
  licenceExpiry: null,
  status,
  notes: '',
  user: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
});

const vehicle = (
  id: string,
  plateNumber: string,
  make: string,
  model: string,
  status = 'ACTIVE',
) => ({
  id,
  plateNumber,
  make,
  model,
  year: 2020,
  status,
  currentOdometer: null,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
});

const ACTIVE_DRIVER = driver(DRIVER_ID, 'Synthetic Driver', 'SYN-0001');
const OTHER_DRIVER = driver(OTHER_DRIVER_ID, 'Second Driver', 'SYN-0002');
const ACTIVE_VEHICLE = vehicle(VEHICLE_ID, 'ABC 123', 'Isuzu', 'N-Series');
const OTHER_VEHICLE = vehicle(OTHER_VEHICLE_ID, 'XYZ 789', 'Hino', 'Ranger');

const trip = (status: TripStatus, overrides: Partial<Trip> = {}): Trip => ({
  id: TRIP_ID,
  status,
  driverId: null,
  vehicleId: null,
  origin: 'Manila',
  destination: 'Cebu',
  scheduledStartAt: null,
  scheduledEndAt: null,
  startedAt: null,
  completedAt: null,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  ...overrides,
});

const ASSIGNED = trip('ASSIGNED', {
  driverId: DRIVER_ID,
  vehicleId: VEHICLE_ID,
  scheduledStartAt: '2026-09-24T00:30:00.000Z',
  scheduledEndAt: '2026-09-24T04:30:00.000Z',
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

interface Routes {
  readonly drivers?: unknown[];
  readonly vehicles?: unknown[];
  readonly driver?: unknown;
  readonly vehicle?: unknown;
  readonly assign?: () => Response | Promise<Response>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

const page = (items: unknown[]) => ({
  items,
  page: 1,
  pageSize: 100,
  total: items.length,
});

/** Routes each call the component can make; unmatched paths 404. */
function installFetch(routes: Routes) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      if (url.includes('/assign')) {
        return routes.assign ? routes.assign() : json(200, ASSIGNED);
      }
      if (url.startsWith('/api/backend/drivers?')) {
        return json(200, page(routes.drivers ?? [ACTIVE_DRIVER, OTHER_DRIVER]));
      }
      if (url.startsWith('/api/backend/vehicles?')) {
        return json(
          200,
          page(routes.vehicles ?? [ACTIVE_VEHICLE, OTHER_VEHICLE]),
        );
      }
      if (url.startsWith('/api/backend/drivers/')) {
        return routes.driver
          ? json(200, routes.driver)
          : json(404, { message: 'driver_not_found' });
      }
      if (url.startsWith('/api/backend/vehicles/')) {
        return routes.vehicle
          ? json(200, routes.vehicle)
          : json(404, { message: 'vehicle_not_found' });
      }
      return json(404, { message: 'not_found' });
    }),
  );
  return calls;
}

const optionLabels = (name: string) =>
  Array.from(
    (screen.getByLabelText(name) as HTMLSelectElement).options,
    (option) => option.textContent,
  );

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

describe('TripAssignment candidates', () => {
  it('asks only for ACTIVE drivers and vehicles', async () => {
    const calls = installFetch({});
    render(<TripAssignment trip={trip('DRAFT')} onChanged={vi.fn()} />);

    await waitFor(() =>
      expect(
        calls.filter((call) => call.url.includes('status=ACTIVE')),
      ).toHaveLength(2),
    );
    expect(calls.map((call) => call.url)).toEqual(
      expect.arrayContaining([
        '/api/backend/drivers?status=ACTIVE&page=1&pageSize=100',
        '/api/backend/vehicles?status=ACTIVE&page=1&pageSize=100',
      ]),
    );
  });

  it('labels drivers and vehicles as specified', async () => {
    installFetch({});
    render(<TripAssignment trip={trip('DRAFT')} onChanged={vi.fn()} />);

    await waitFor(() =>
      expect(optionLabels('Driver')).toContain('Synthetic Driver — SYN-0001'),
    );
    expect(optionLabels('Vehicle')).toContain('ABC 123 — Isuzu N-Series');
  });

  it('searches each resource on submit, keeping the ACTIVE filter', async () => {
    const calls = installFetch({});
    render(<TripAssignment trip={trip('DRAFT')} onChanged={vi.fn()} />);
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));

    fireEvent.change(screen.getByLabelText('Search drivers'), {
      target: { value: '  syn  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search drivers' }));
    await waitFor(() =>
      expect(calls.map((call) => call.url)).toContain(
        '/api/backend/drivers?q=syn&status=ACTIVE&page=1&pageSize=100',
      ),
    );

    fireEvent.change(screen.getByLabelText('Search vehicles'), {
      target: { value: 'abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search vehicles' }));
    await waitFor(() =>
      expect(calls.map((call) => call.url)).toContain(
        '/api/backend/vehicles?q=abc&status=ACTIVE&page=1&pageSize=100',
      ),
    );
  });
});

describe('TripAssignment on an assigned trip', () => {
  it('prefills the assignment and the schedule in Manila time', async () => {
    installFetch({ driver: ACTIVE_DRIVER, vehicle: ACTIVE_VEHICLE });
    render(<TripAssignment trip={ASSIGNED} onChanged={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByLabelText('Driver')).toHaveValue(DRIVER_ID),
    );
    expect(screen.getByLabelText('Vehicle')).toHaveValue(VEHICLE_ID);
    // 00:30 UTC is 08:30 in Manila, and the labels say so.
    expect(
      screen.getByLabelText('Scheduled start (Asia/Manila time)'),
    ).toHaveValue('2026-09-24T08:30');
    expect(
      screen.getByLabelText('Scheduled end (Asia/Manila time)'),
    ).toHaveValue('2026-09-24T12:30');
    expect(
      screen.getByRole('button', { name: 'Reassign / reschedule' }),
    ).toBeInTheDocument();
  });

  it('keeps a deactivated current driver visible, marked with its status', async () => {
    const inactive = driver(
      DRIVER_ID,
      'Synthetic Driver',
      'SYN-0001',
      'INACTIVE',
    );
    installFetch({
      drivers: [OTHER_DRIVER],
      driver: inactive,
      vehicle: ACTIVE_VEHICLE,
    });
    render(<TripAssignment trip={ASSIGNED} onChanged={vi.fn()} />);

    await waitFor(() =>
      expect(optionLabels('Driver')).toContain(
        'Synthetic Driver — SYN-0001 — INACTIVE',
      ),
    );
    expect(screen.getByLabelText('Driver')).toHaveValue(DRIVER_ID);
  });

  it('keeps a retired current vehicle visible, marked with its status', async () => {
    const retired = vehicle(
      VEHICLE_ID,
      'ABC 123',
      'Isuzu',
      'N-Series',
      'IN_MAINTENANCE',
    );
    installFetch({
      vehicles: [OTHER_VEHICLE],
      driver: ACTIVE_DRIVER,
      vehicle: retired,
    });
    render(<TripAssignment trip={ASSIGNED} onChanged={vi.fn()} />);

    await waitFor(() =>
      expect(optionLabels('Vehicle')).toContain(
        'ABC 123 — Isuzu N-Series — IN_MAINTENANCE',
      ),
    );
  });

  it('refuses to submit a non-ACTIVE current resource', async () => {
    const inactive = driver(
      DRIVER_ID,
      'Synthetic Driver',
      'SYN-0001',
      'INACTIVE',
    );
    const calls = installFetch({
      drivers: [OTHER_DRIVER],
      driver: inactive,
      vehicle: ACTIVE_VEHICLE,
    });
    render(<TripAssignment trip={ASSIGNED} onChanged={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByLabelText('Driver')).toHaveValue(DRIVER_ID),
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Reassign / reschedule' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Select an active driver before assigning this trip.',
    );
    expect(calls.filter((call) => call.url.includes('/assign'))).toHaveLength(
      0,
    );
  });
});

describe('TripAssignment submission', () => {
  async function ready(overrides: Routes = {}) {
    const calls = installFetch(overrides);
    render(<TripAssignment trip={trip('DRAFT')} onChanged={vi.fn()} />);
    await waitFor(() =>
      expect(optionLabels('Driver')).toContain('Synthetic Driver — SYN-0001'),
    );
    return calls;
  }

  /**
   * Submits the form itself rather than clicking the button.
   *
   * The selects and the datetime inputs are , so a browser blocks
   * an empty or unparseable submission before any handler runs — and jsdom
   * does the same. These two checks are the backstop behind that, and this
   * is the only way to reach them.
   */
  const submitDirectly = () => {
    fireEvent.submit(
      screen.getByRole('button', { name: 'Assign trip' }).closest('form')!,
    );
  };

  const fill = (start: string, end: string) => {
    fireEvent.change(screen.getByLabelText('Driver'), {
      target: { value: DRIVER_ID },
    });
    fireEvent.change(screen.getByLabelText('Vehicle'), {
      target: { value: VEHICLE_ID },
    });
    fireEvent.change(
      screen.getByLabelText('Scheduled start (Asia/Manila time)'),
      { target: { value: start } },
    );
    fireEvent.change(
      screen.getByLabelText('Scheduled end (Asia/Manila time)'),
      {
        target: { value: end },
      },
    );
  };

  it('converts Manila wall-clock to UTC in the assign payload', async () => {
    const calls = await ready();
    fill('2026-09-24T08:30', '2026-09-24T12:30');

    fireEvent.click(screen.getByRole('button', { name: 'Assign trip' }));

    await waitFor(() =>
      expect(calls.some((call) => call.url.includes('/assign'))).toBe(true),
    );
    const assign = calls.find((call) => call.url.includes('/assign'))!;
    expect(assign).toMatchObject({
      url: `/api/backend/trips/${TRIP_ID}/assign`,
      method: 'POST',
      body: {
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        scheduledStartAt: '2026-09-24T00:30:00.000Z',
        scheduledEndAt: '2026-09-24T04:30:00.000Z',
      },
    });
    expect(Object.keys(assign.body as object).sort()).toEqual([
      'driverId',
      'scheduledEndAt',
      'scheduledStartAt',
      'vehicleId',
    ]);
  });

  it.each([
    ['an inverted window', '2026-09-24T12:30', '2026-09-24T08:30'],
    ['an empty window', '2026-09-24T08:30', '2026-09-24T08:30'],
  ])('rejects %s before sending anything', async (_label, start, end) => {
    const calls = await ready();
    fill(start, end);

    fireEvent.click(screen.getByRole('button', { name: 'Assign trip' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Scheduled end must be after scheduled start.',
    );
    expect(calls.filter((call) => call.url.includes('/assign'))).toHaveLength(
      0,
    );
  });

  it('rejects an unusable timestamp without sending it', async () => {
    const calls = await ready();
    fill('not-a-date', '2026-09-24T12:30');

    submitDirectly();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a valid scheduled start and end.',
    );
    expect(calls.filter((call) => call.url.includes('/assign'))).toHaveLength(
      0,
    );
  });

  it('requires both a driver and a vehicle', async () => {
    const calls = await ready();
    fireEvent.change(
      screen.getByLabelText('Scheduled start (Asia/Manila time)'),
      { target: { value: '2026-09-24T08:30' } },
    );
    fireEvent.change(
      screen.getByLabelText('Scheduled end (Asia/Manila time)'),
      {
        target: { value: '2026-09-24T12:30' },
      },
    );

    submitDirectly();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose a driver and a vehicle.',
    );
    expect(calls.filter((call) => call.url.includes('/assign'))).toHaveLength(
      0,
    );
  });

  it('hands the authoritative response to onChanged', async () => {
    installFetch({ assign: () => json(200, ASSIGNED) });
    const onChanged = vi.fn();
    render(<TripAssignment trip={trip('DRAFT')} onChanged={onChanged} />);
    await waitFor(() =>
      expect(optionLabels('Driver')).toContain('Synthetic Driver — SYN-0001'),
    );
    fill('2026-09-24T08:30', '2026-09-24T12:30');

    fireEvent.click(screen.getByRole('button', { name: 'Assign trip' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(ASSIGNED));
    expect(screen.getByRole('status')).toHaveTextContent('Assignment saved.');
  });

  it.each([
    [
      'trip_schedule_conflict',
      409,
      'That driver or vehicle already has a trip in the selected time window.',
    ],
    ['driver_inactive', 409, 'This driver is inactive.'],
    ['vehicle_not_active', 409, 'The selected vehicle is not active.'],
    [
      'trip_not_assignable',
      409,
      'This trip can no longer be assigned or rescheduled.',
    ],
    ['driver_not_found', 404, 'This driver no longer exists.'],
  ])(
    'shows the server message for %s and changes nothing',
    async (code, status, message) => {
      installFetch({ assign: () => json(status, { message: code }) });
      const onChanged = vi.fn();
      render(<TripAssignment trip={trip('DRAFT')} onChanged={onChanged} />);
      await waitFor(() =>
        expect(optionLabels('Driver')).toContain('Synthetic Driver — SYN-0001'),
      );
      fill('2026-09-24T08:30', '2026-09-24T12:30');

      fireEvent.click(screen.getByRole('button', { name: 'Assign trip' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(onChanged).not.toHaveBeenCalled();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      // The typed values survive so the admin can correct and retry.
      expect(screen.getByLabelText('Driver')).toHaveValue(DRIVER_ID);
      expect(
        screen.getByLabelText('Scheduled start (Asia/Manila time)'),
      ).toHaveValue('2026-09-24T08:30');
    },
  );

  it('never renders a token or an API origin', async () => {
    await ready();
    expect(document.body.innerHTML).not.toMatch(
      /accessToken|refreshToken|mansar_|Authorization|https?:\/\//,
    );
  });
});
