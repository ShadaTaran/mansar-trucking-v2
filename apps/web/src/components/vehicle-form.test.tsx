import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { replace, refresh, router } = vi.hoisted(() => {
  const replace = vi.fn();
  const refresh = vi.fn();
  return { replace, refresh, router: { replace, refresh } };
});
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/vehicles/new',
}));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { VehicleForm } from './vehicle-form';

const VEHICLE = {
  id: '019a0000-0000-7000-8000-00000000000e',
  plateNumber: 'SYN 0001',
  make: 'Synthetic',
  model: 'Hauler',
  year: 2020,
  status: 'ACTIVE' as const,
  currentOdometer: 125000,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function installFetch(handler: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return handler();
    }),
  );
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

function fill(values: Record<string, string>) {
  for (const [label, value] of Object.entries(values)) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

beforeEach(() => {
  resetAuthenticatedFetchForTests();
  replace.mockReset();
  refresh.mockReset();
  Object.defineProperty(navigator, 'locks', {
    value: undefined,
    configurable: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VehicleForm (create)', () => {
  it('posts the plate as typed and follows the API to the new vehicle', async () => {
    const calls = installFetch(() => json(201, VEHICLE));
    render(<VehicleForm vehicle={null} />);

    fill({
      'Plate number': ' syn   0001 ',
      Make: 'Synthetic',
      Model: 'Hauler',
      Year: '2020',
      'Current odometer': '125000',
      Notes: '',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create vehicle' }));

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(`/vehicles/${VEHICLE.id}`),
    );
    // Canonical normalization belongs to the API, not the browser.
    expect(calls[0]).toMatchObject({
      url: '/api/backend/vehicles',
      method: 'POST',
      body: {
        plateNumber: ' syn   0001 ',
        make: 'Synthetic',
        model: 'Hauler',
        year: 2020,
        currentOdometer: 125000,
        notes: '',
      },
    });
  });

  it('sends a null odometer when the field is left empty', async () => {
    const calls = installFetch(() => json(201, VEHICLE));
    render(<VehicleForm vehicle={null} />);
    fill({
      'Plate number': 'SYN 0002',
      Make: 'A',
      Model: 'B',
      Year: '2021',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create vehicle' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ currentOdometer: null });
  });

  it('maps a duplicate plate and keeps what was typed', async () => {
    installFetch(() =>
      json(409, { statusCode: 409, message: 'duplicate_plate_number' }),
    );
    render(<VehicleForm vehicle={null} />);
    fill({
      'Plate number': 'SYN 0001',
      Make: 'Synthetic',
      Model: 'Hauler',
      Year: '2020',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create vehicle' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A vehicle with this plate number already exists.',
    );
    expect(screen.getByLabelText('Plate number')).toHaveValue('SYN 0001');
    expect(screen.getByLabelText('Make')).toHaveValue('Synthetic');
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows server validation messages', async () => {
    installFetch(() =>
      json(400, {
        statusCode: 400,
        message: ['year must be 1950 or later'],
        error: 'Bad Request',
      }),
    );
    render(<VehicleForm vehicle={null} />);
    fill({
      'Plate number': 'SYN 0003',
      Make: 'A',
      Model: 'B',
      Year: '1800',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create vehicle' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Please check the values you entered.');
    expect(alert).toHaveTextContent('year must be 1950 or later');
  });

  it('never offers a status field', () => {
    installFetch(() => json(201, VEHICLE));
    render(<VehicleForm vehicle={null} />);
    expect(screen.queryByLabelText(/status/i)).not.toBeInTheDocument();
  });
});

describe('VehicleForm (edit)', () => {
  it('pre-fills the record and patches it, showing the canonical plate back', async () => {
    const calls = installFetch(() =>
      json(200, { ...VEHICLE, plateNumber: 'ABC 123' }),
    );
    const onSaved = vi.fn();
    render(<VehicleForm vehicle={VEHICLE} onSaved={onSaved} />);

    expect(screen.getByLabelText('Plate number')).toHaveValue('SYN 0001');
    expect(screen.getByLabelText('Current odometer')).toHaveValue(125000);

    fill({ 'Plate number': ' abc  123 ' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls[0]).toMatchObject({
      url: `/api/backend/vehicles/${VEHICLE.id}`,
      method: 'PATCH',
    });
    expect(screen.getByLabelText('Plate number')).toHaveValue('ABC 123');
    expect(replace).not.toHaveBeenCalled();
  });

  it('clears the odometer without any monotonic rule in the way', async () => {
    const calls = installFetch(() =>
      json(200, { ...VEHICLE, currentOdometer: null }),
    );
    render(<VehicleForm vehicle={VEHICLE} onSaved={vi.fn()} />);

    fill({ 'Current odometer': '' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ currentOdometer: null });

    fill({ 'Current odometer': '10' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.body).toMatchObject({ currentOdometer: 10 });
  });
});
