import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/vehicles',
}));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { VehicleStatusControl } from './vehicle-status';

const VEHICLE = {
  id: '019a0000-0000-7000-8000-00000000000e',
  plateNumber: 'SYN 0001',
  make: 'Synthetic',
  model: 'Hauler',
  year: 2020,
  status: 'ACTIVE' as const,
  currentOdometer: null,
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

describe('VehicleStatusControl', () => {
  it('offers all three states, from any current state', () => {
    installFetch(() => json(200, VEHICLE));
    render(
      <VehicleStatusControl
        vehicle={{ ...VEHICLE, status: 'RETIRED' }}
        onChanged={vi.fn()}
      />,
    );
    const select = screen.getByLabelText('Change status to');
    expect(
      Array.from(select.querySelectorAll('option')).map((o) => o.value),
    ).toEqual(['ACTIVE', 'IN_MAINTENANCE', 'RETIRED']);
    // Nothing is terminal in Stage 4: a retired vehicle can go back.
    expect(select).toHaveValue('RETIRED');
  });

  it.each(['IN_MAINTENANCE', 'RETIRED'] as const)(
    'changes an active vehicle to %s after confirmation',
    async (status) => {
      const calls = installFetch(() => json(200, { ...VEHICLE, status }));
      const onChanged = vi.fn();
      render(<VehicleStatusControl vehicle={VEHICLE} onChanged={onChanged} />);

      fireEvent.change(screen.getByLabelText('Change status to'), {
        target: { value: status },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Change status' }));
      expect(calls).toHaveLength(0);
      expect(
        screen.getByText(`Change this vehicle from ACTIVE to ${status}?`),
      ).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole('button', { name: 'Confirm status change' }),
      );

      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(calls[0]).toMatchObject({
        url: `/api/backend/vehicles/${VEHICLE.id}/status`,
        method: 'POST',
        body: { status },
      });
      expect(await screen.findByRole('status')).toHaveTextContent(
        `Status changed to ${status}.`,
      );
    },
  );

  it('reactivates a retired vehicle', async () => {
    const calls = installFetch(() => json(200, VEHICLE));
    const onChanged = vi.fn();
    render(
      <VehicleStatusControl
        vehicle={{ ...VEHICLE, status: 'RETIRED' }}
        onChanged={onChanged}
      />,
    );
    fireEvent.change(screen.getByLabelText('Change status to'), {
      target: { value: 'ACTIVE' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change status' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm status change' }),
    );

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls[0]!.body).toEqual({ status: 'ACTIVE' });
  });

  it('can be cancelled without calling the API', () => {
    const calls = installFetch(() => json(200, VEHICLE));
    render(<VehicleStatusControl vehicle={VEHICLE} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change status' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.queryByRole('button', { name: 'Confirm status change' }),
    ).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('maps the same-state conflict and a missing vehicle', async () => {
    installFetch(() =>
      json(409, { statusCode: 409, message: 'vehicle_status_unchanged' }),
    );
    const onChanged = vi.fn();
    const { unmount } = render(
      <VehicleStatusControl vehicle={VEHICLE} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change status' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm status change' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This vehicle is already in that state.',
    );
    expect(onChanged).not.toHaveBeenCalled();
    unmount();

    vi.unstubAllGlobals();
    installFetch(() =>
      json(404, { statusCode: 404, message: 'vehicle_not_found' }),
    );
    render(<VehicleStatusControl vehicle={VEHICLE} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change status' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm status change' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This vehicle no longer exists.',
    );
  });

  it('disables the confirm button while the change is pending', async () => {
    let release: (() => void) | undefined;
    installFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json(200, VEHICLE));
        }),
    );
    const onChanged = vi.fn();
    render(<VehicleStatusControl vehicle={VEHICLE} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText('Change status to'), {
      target: { value: 'RETIRED' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change status' }));
    const confirm = screen.getByRole('button', {
      name: 'Confirm status change',
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(confirm).toBeDisabled());
    release?.();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
