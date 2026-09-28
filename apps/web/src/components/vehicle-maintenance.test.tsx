import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/vehicles',
}));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { VehicleDetail } from './vehicle-detail';
import { VehicleMaintenance } from './vehicle-maintenance';

const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const OPEN_ID = '019a0000-0000-7000-8000-00000000007c';
const DONE_ID = '019a0000-0000-7000-8000-00000000007d';

const RETIRED_VEHICLE = {
  id: VEHICLE_ID,
  plateNumber: 'SYN 0001',
  make: 'Synthetic',
  model: 'Hauler',
  year: 2020,
  status: 'RETIRED',
  currentOdometer: 125000,
  notes: '',
  createdAt: '2026-09-01T08:30:00.000Z',
  updatedAt: '2026-09-02T09:45:00.000Z',
};

const OPEN_RECORD = {
  id: OPEN_ID,
  vehicleId: VEHICLE_ID,
  status: 'OPEN',
  category: 'REPAIR',
  startedAt: '2026-09-24T00:30:00.000Z',
  completedAt: null,
  odometer: 125000,
  cost: '12500.00',
  description: 'Synthetic brake overhaul',
  createdAt: '2026-09-24T01:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z',
};

const COMPLETED_RECORD = {
  id: DONE_ID,
  vehicleId: VEHICLE_ID,
  status: 'COMPLETED',
  category: 'TIRE',
  startedAt: '2026-09-20T02:15:00.000Z',
  completedAt: '2026-09-21T06:45:00.000Z',
  odometer: null,
  cost: null,
  description: '',
  createdAt: '2026-09-20T03:00:00.000Z',
  updatedAt: '2026-09-21T07:00:00.000Z',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

const page = (items: unknown[], total = items.length, current = 1) => ({
  items,
  page: current,
  pageSize: 25,
  total,
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function installFetch(handler: (url: string, method: string) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({
        url,
        method,
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      return handler(url, method);
    }),
  );
  return calls;
}

const LIST_URL = `/api/backend/maintenance?vehicleId=${VEHICLE_ID}&page=1&pageSize=25`;

const listGets = (calls: readonly Call[]) =>
  calls.filter(
    (call) =>
      call.method === 'GET' && call.url.startsWith('/api/backend/maintenance'),
  );

const createForm = () =>
  screen.getByRole('button', { name: 'Add maintenance' }).closest('form')!;
const editForm = () =>
  screen.getByRole('button', { name: 'Save changes' }).closest('form')!;

/** The `dd` values of one record, in the order the section renders them. */
function recordFields(index = 0): string[] {
  const items = screen.getAllByRole('listitem');
  return Array.from(items[index]!.querySelectorAll('dl > dd')).map(
    (cell) => cell.textContent ?? '',
  );
}

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

describe('VehicleMaintenance query', () => {
  it('asks only for this vehicle, and for its whole history', async () => {
    const calls = installFetch(() => json(200, page([])));
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByText(
      'No maintenance has been recorded for this vehicle.',
    );

    expect(calls[0]!.url).toBe(LIST_URL);
    // Deliberately no status filter: a vehicle's own page answers "what has
    // been done to this truck", which the OPEN-only worklist would not.
    expect(calls[0]!.url).not.toContain('status=');
  });

  it('never sends a category, trip or driver filter either', async () => {
    const calls = installFetch(() => json(200, page([OPEN_RECORD])));
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByRole('list');

    for (const forbidden of ['status=', 'category=', 'tripId=', 'driverId=']) {
      expect(calls[0]!.url).not.toContain(forbidden);
    }
  });
});

describe('VehicleMaintenance states', () => {
  it('shows a loading state first', () => {
    installFetch(() => json(200, page([])));
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading maintenance…',
    );
  });

  it('reports a failure as an alert', async () => {
    installFetch(() => json(500, { message: 'boom' }));
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again shortly.',
    );
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('says so when this vehicle has no history', async () => {
    installFetch(() => json(200, page([])));
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    expect(
      await screen.findByText(
        'No maintenance has been recorded for this vehicle.',
      ),
    ).toBeInTheDocument();
  });

  it('states the heading and that status is unaffected', async () => {
    installFetch(() => json(200, page([])));
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Maintenance' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Recording maintenance does not change the vehicle's operational status.",
      ),
    ).toBeInTheDocument();
  });
});

describe('VehicleMaintenance listing', () => {
  it('renders the server order exactly, without re-sorting', async () => {
    installFetch(() => json(200, page([OPEN_RECORD, COMPLETED_RECORD])));
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByRole('list');

    expect(recordFields(0)[0]).toBe('2026-09-24 08:30 Asia/Manila');
    expect(recordFields(1)[0]).toBe('2026-09-20 10:15 Asia/Manila');
  });

  it('shows the seven agreed values with the shared display rules', async () => {
    installFetch(() => json(200, page([OPEN_RECORD])));
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByRole('list');

    expect(recordFields(0)).toEqual([
      '2026-09-24 08:30 Asia/Manila',
      'REPAIR',
      'OPEN',
      '125000',
      '₱12,500.00',
      '—',
      'Synthetic brake overhaul',
    ]);
  });

  it('shows a placeholder for every absent value', async () => {
    installFetch(() => json(200, page([COMPLETED_RECORD])));
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByRole('list');

    expect(recordFields(0)).toEqual([
      '2026-09-20 10:15 Asia/Manila',
      'TIRE',
      'COMPLETED',
      '—',
      '—',
      '2026-09-21 14:45 Asia/Manila',
      '—',
    ]);
  });

  it('counts with the server total', async () => {
    installFetch(() => json(200, page([OPEN_RECORD], 60, 1)));
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByRole('list');
    expect(
      screen.getByText('60 maintenance records on this vehicle'),
    ).toBeInTheDocument();
  });

  it('pages on the server', async () => {
    const calls = installFetch((url) =>
      json(
        200,
        url.includes('page=2')
          ? page([COMPLETED_RECORD], 60, 2)
          : page([OPEN_RECORD], 60, 1),
      ),
    );
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByRole('list');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(calls.map((call) => call.url)).toContain(
        `/api/backend/maintenance?vehicleId=${VEHICLE_ID}&page=2&pageSize=25`,
      ),
    );
    await waitFor(() => expect(recordFields(0)[2]).toBe('COMPLETED'));
  });
});

describe('VehicleMaintenance controls', () => {
  it('keeps the create form present even with no history', async () => {
    installFetch(() => json(200, page([])));
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByText(
      'No maintenance has been recorded for this vehicle.',
    );

    expect(
      screen.getByRole('button', { name: 'Add maintenance' }),
    ).toBeEnabled();
    expect(within(createForm()).getByLabelText('Category')).toBeInTheDocument();
  });

  it('gives an OPEN record both an edit form and the lifecycle controls', async () => {
    installFetch(() => json(200, page([OPEN_RECORD])));
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByRole('list');

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Complete maintenance' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Cancel maintenance' }),
    ).toBeEnabled();
    expect(within(editForm()).getByLabelText('Description')).toHaveValue(
      'Synthetic brake overhaul',
    );
  });

  it.each(['COMPLETED', 'CANCELLED'] as const)(
    'leaves a %s record read-only',
    async (status) => {
      installFetch(() => json(200, page([{ ...COMPLETED_RECORD, status }])));
      render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
      await screen.findByRole('list');

      // No edit, no lifecycle control, no delete and no reopen.
      expect(
        screen.queryByRole('button', { name: 'Save changes' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Complete maintenance' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Cancel maintenance' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /delete|reopen/i }),
      ).not.toBeInTheDocument();
      // The create form is still there: history does not stop new work.
      expect(
        screen.getByRole('button', { name: 'Add maintenance' }),
      ).toBeEnabled();
    },
  );
});

describe('VehicleMaintenance reloads after every mutation', () => {
  it('re-reads the list after a create', async () => {
    const calls = installFetch((url, method) =>
      method === 'POST' && url.endsWith('/maintenance')
        ? json(201, OPEN_RECORD)
        : json(200, page([OPEN_RECORD])),
    );
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByRole('list');
    expect(listGets(calls)).toHaveLength(1);

    const form = createForm();
    fireEvent.change(within(form).getByLabelText('Started at (Asia/Manila)'), {
      target: { value: '2026-09-24T08:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add maintenance' }));

    // Never a spliced-in row: the server's list is the record of truth.
    await waitFor(() => expect(listGets(calls)).toHaveLength(2));
    expect(listGets(calls)[1]!.url).toBe(LIST_URL);
  });

  it('re-reads the list after an edit', async () => {
    const calls = installFetch((_url, method) =>
      method === 'PATCH'
        ? json(200, { ...OPEN_RECORD, description: 'Synthetic note' })
        : json(200, page([OPEN_RECORD])),
    );
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByRole('list');

    fireEvent.change(within(editForm()).getByLabelText('Description'), {
      target: { value: 'Synthetic note' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(listGets(calls)).toHaveLength(2));
  });

  it('re-reads the list after a completion', async () => {
    const calls = installFetch((url) =>
      url.endsWith('/complete')
        ? json(200, {
            ...OPEN_RECORD,
            status: 'COMPLETED',
            completedAt: '2026-09-25T02:00:00.000Z',
          })
        : json(200, page([OPEN_RECORD])),
    );
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByRole('list');

    fireEvent.click(
      screen.getByRole('button', { name: 'Complete maintenance' }),
    );
    fireEvent.change(screen.getByLabelText('Completed at (Asia/Manila)'), {
      target: { value: '2026-09-25T10:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm completion' }));

    await waitFor(() => expect(listGets(calls)).toHaveLength(2));
  });

  it('re-reads the list after a cancellation', async () => {
    const calls = installFetch((url) =>
      url.endsWith('/cancel')
        ? json(200, { ...OPEN_RECORD, status: 'CANCELLED' })
        : json(200, page([OPEN_RECORD])),
    );
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByRole('list');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel maintenance' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm cancellation' }),
    );

    await waitFor(() => expect(listGets(calls)).toHaveLength(2));
  });

  it('re-reads the list when a lifecycle race is lost', async () => {
    const calls = installFetch((url) =>
      url.endsWith('/cancel')
        ? json(409, { statusCode: 409, message: 'maintenance_not_cancellable' })
        : json(200, page([OPEN_RECORD])),
    );
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByRole('list');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel maintenance' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm cancellation' }),
    );

    // The list decides which terminal state won, not this component.
    await waitFor(() => expect(listGets(calls)).toHaveLength(2));
  });

  it('never calls the vehicle status endpoint for any interaction', async () => {
    const calls = installFetch((url) =>
      url.endsWith('/cancel')
        ? json(200, { ...OPEN_RECORD, status: 'CANCELLED' })
        : json(200, page([OPEN_RECORD])),
    );
    render(<VehicleMaintenance vehicleId={VEHICLE_ID} />);
    await screen.findByRole('list');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel maintenance' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm cancellation' }),
    );
    await waitFor(() => expect(listGets(calls)).toHaveLength(2));

    for (const call of calls) {
      expect(call.url).not.toContain(`/vehicles/${VEHICLE_ID}/status`);
      expect(call.url).not.toMatch(/\/status$/);
    }
  });
});

describe('VehicleMaintenance under a RETIRED vehicle', () => {
  it('still offers maintenance entry through VehicleDetail', async () => {
    const calls = installFetch((url) =>
      url.startsWith('/api/backend/maintenance')
        ? json(200, page([COMPLETED_RECORD]))
        : json(200, RETIRED_VEHICLE),
    );
    render(<VehicleDetail vehicleId={VEHICLE_ID} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'SYN 0001' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Change status to')).toHaveValue('RETIRED');

    // Vehicle.status is not an eligibility input for maintenance (ADR 0010):
    // a retired truck still accrues work that has to be recorded.
    expect(
      await screen.findByRole('button', { name: 'Add maintenance' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Maintenance' }),
    ).toBeInTheDocument();
    // And the section was still asked for the whole history.
    expect(
      calls.some((call) => call.url === LIST_URL && call.method === 'GET'),
    ).toBe(true);
  });

  it('files a record against a RETIRED vehicle without touching its status', async () => {
    const calls = installFetch((url, method) =>
      url.startsWith('/api/backend/maintenance')
        ? json(200, page([]))
        : method === 'POST'
          ? json(201, OPEN_RECORD)
          : json(200, RETIRED_VEHICLE),
    );
    render(<VehicleDetail vehicleId={VEHICLE_ID} />);
    await screen.findByRole('button', { name: 'Add maintenance' });

    fireEvent.change(
      within(createForm()).getByLabelText('Started at (Asia/Manila)'),
      { target: { value: '2026-09-24T08:30' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add maintenance' }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === 'POST' &&
            call.url === `/api/backend/vehicles/${VEHICLE_ID}/maintenance`,
        ),
      ).toBe(true),
    );
    for (const call of calls) {
      expect(call.url).not.toBe(`/api/backend/vehicles/${VEHICLE_ID}/status`);
    }
  });
});
