import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { MaintenanceActions } from './maintenance-actions';

const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const MAINTENANCE_ID = '019a0000-0000-7000-8000-00000000007c';

const OPEN_RECORD = {
  id: MAINTENANCE_ID,
  vehicleId: VEHICLE_ID,
  status: 'OPEN' as const,
  category: 'REPAIR' as const,
  startedAt: '2026-09-24T00:30:00.000Z',
  completedAt: null,
  odometer: 125000,
  cost: '12500.00',
  description: 'Synthetic brake overhaul',
  createdAt: '2026-09-24T01:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z',
};

const COMPLETED_ROW = {
  ...OPEN_RECORD,
  status: 'COMPLETED' as const,
  completedAt: '2026-09-25T02:00:00.000Z',
  cost: '13000.00',
  updatedAt: '2026-09-25T02:00:00.000Z',
};

const CANCELLED_ROW = {
  ...OPEN_RECORD,
  status: 'CANCELLED' as const,
  updatedAt: '2026-09-25T02:00:00.000Z',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Record<string, string> | undefined;
}

function installFetch(handler: () => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
        headers: init?.headers as Record<string, string> | undefined,
      });
      return handler();
    }),
  );
  return calls;
}

const startComplete = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Complete maintenance' }));
const startCancel = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Cancel maintenance' }));
const confirmComplete = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Confirm completion' }));
const confirmCancel = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));

function fillCompletion(completedAt = '2026-09-25T10:00', cost = '') {
  fireEvent.change(screen.getByLabelText('Completed at (Asia/Manila)'), {
    target: { value: completedAt },
  });
  fireEvent.change(screen.getByLabelText('Final cost (PHP)'), {
    target: { value: cost },
  });
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

describe('MaintenanceActions visibility', () => {
  it.each(['COMPLETED', 'CANCELLED'] as const)(
    'renders nothing for a %s record',
    (status) => {
      const { container } = render(
        <MaintenanceActions
          record={{ ...OPEN_RECORD, status }}
          onChanged={vi.fn()}
          onStale={vi.fn()}
        />,
      );
      // Both are terminal: there is no reopen and no delete, so there is
      // nothing left to offer.
      expect(container).toBeEmptyDOMElement();
    },
  );

  it('offers both transitions for an OPEN record', () => {
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Complete maintenance' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Cancel maintenance' }),
    ).toBeEnabled();
  });

  it('offers no delete and no reopen', () => {
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /delete/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /reopen/i }),
    ).not.toBeInTheDocument();
  });
});

describe('MaintenanceActions complete', () => {
  it('requires a confirmation before anything is sent', async () => {
    const calls = installFetch(() => json(200, COMPLETED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Confirm completion' }),
    ).not.toBeInTheDocument();
    startComplete();

    expect(
      screen.getByRole('button', { name: 'Confirm completion' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Keep open' })).toBeEnabled();
    // Opening the confirmation is not the decision.
    expect(calls).toHaveLength(0);
  });

  it('abandons the confirmation without sending anything', async () => {
    const calls = installFetch(() => json(200, COMPLETED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    startComplete();
    fireEvent.click(screen.getByRole('button', { name: 'Keep open' }));

    expect(
      screen.getByRole('button', { name: 'Complete maintenance' }),
    ).toBeEnabled();
    expect(calls).toHaveLength(0);
  });

  it('converts the completion instant as Manila wall-clock', async () => {
    const calls = installFetch(() => json(200, COMPLETED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    startComplete();
    fillCompletion('2026-12-31T23:45', '');
    confirmComplete();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(
      `/api/backend/maintenance/${MAINTENANCE_ID}/complete`,
    );
    expect(calls[0]!.method).toBe('POST');
    expect((calls[0]!.body as { completedAt: string }).completedAt).toBe(
      '2026-12-31T15:45:00.000Z',
    );
  });

  it('never invents a completion timestamp from the browser clock', async () => {
    const calls = installFetch(() => json(200, COMPLETED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    startComplete();
    fillCompletion('2026-09-25T10:00', '');
    confirmComplete();

    await waitFor(() => expect(calls).toHaveLength(1));
    // Yesterday's paperwork records yesterday, not today.
    expect((calls[0]!.body as { completedAt: string }).completedAt).toBe(
      '2026-09-25T02:00:00.000Z',
    );
  });

  it('sends a null cost when the field is left blank', async () => {
    const calls = installFetch(() => json(200, COMPLETED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    startComplete();
    fillCompletion('2026-09-25T10:00', '');
    confirmComplete();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({
      completedAt: '2026-09-25T02:00:00.000Z',
      cost: null,
    });
    // The API requires the key: omitting it is a 400, not a null cost.
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual([
      'completedAt',
      'cost',
    ]);
  });

  it.each(['0', '0.00', '99.5', '13000.00', '9999999999.99'])(
    'preserves the final cost %s as the exact string typed',
    async (cost) => {
      const calls = installFetch(() => json(200, COMPLETED_ROW));
      render(
        <MaintenanceActions
          record={OPEN_RECORD}
          onChanged={vi.fn()}
          onStale={vi.fn()}
        />,
      );
      startComplete();
      fillCompletion('2026-09-25T10:00', cost);
      confirmComplete();

      await waitFor(() => expect(calls).toHaveLength(1));
      const body = calls[0]!.body as { cost: unknown };
      expect(body.cost).toBe(cost);
      expect(typeof body.cost).toBe('string');
    },
  );

  it('accepts a zero final cost, which an expense amount would refuse', async () => {
    const calls = installFetch(() => json(200, COMPLETED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    startComplete();
    fillCompletion('2026-09-25T10:00', '0.00');
    confirmComplete();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]!.body as { cost: string }).cost).toBe('0.00');
  });

  it('refuses a completion instant that will not convert', async () => {
    const calls = installFetch(() => json(200, COMPLETED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    startComplete();
    // A datetime-local input will not hold an impossible date, so the field
    // stays empty — and an empty instant must not become a request either.
    fillCompletion('2026-02-30T08:00', '');
    expect(screen.getByLabelText('Completed at (Asia/Manila)')).toHaveValue('');
    confirmComplete();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a valid date and time.',
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['three decimal places', '1.005'],
    ['a negative cost', '-1'],
    ['exponent notation', '1e3'],
    ['a trailing dot', '10.'],
    ['a thousands separator', '1,250.00'],
    ['eleven integer digits', '10000000000'],
    ['a leading-zero run', '0100'],
  ])('refuses %s as a final cost', async (_label, cost) => {
    const calls = installFetch(() => json(200, COMPLETED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    startComplete();
    fillCompletion('2026-09-25T10:00', cost);
    confirmComplete();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a cost with at most two decimal places.',
    );
    expect(calls).toHaveLength(0);
  });

  it('confirms success and hands the returned row upward', async () => {
    const onChanged = vi.fn();
    installFetch(() => json(200, COMPLETED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={onChanged}
        onStale={vi.fn()}
      />,
    );
    startComplete();
    fillCompletion('2026-09-25T10:00', '13000.00');
    confirmComplete();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Maintenance completed.',
    );
    // The authoritative row decides the new state, not a local guess.
    expect(onChanged).toHaveBeenCalledWith(COMPLETED_ROW);
  });

  it('warns that the final cost replaces whatever the record held', () => {
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    startComplete();
    expect(
      screen.getByText(/This replaces any cost already on the record\./),
    ).toBeInTheDocument();
  });
});

describe('MaintenanceActions cancel', () => {
  it('requires an explicit confirmation', async () => {
    const calls = installFetch(() => json(200, CANCELLED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );

    expect(
      screen.queryByText('Cancel this maintenance record?'),
    ).not.toBeInTheDocument();
    startCancel();

    expect(
      screen.getByText('Cancel this maintenance record?'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Confirm cancellation' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Keep open' })).toBeEnabled();
    expect(calls).toHaveLength(0);
  });

  it('abandons the confirmation without sending anything', async () => {
    const calls = installFetch(() => json(200, CANCELLED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    startCancel();
    fireEvent.click(screen.getByRole('button', { name: 'Keep open' }));

    expect(
      screen.getByRole('button', { name: 'Cancel maintenance' }),
    ).toBeEnabled();
    expect(calls).toHaveLength(0);
  });

  it('posts with no request body at all', async () => {
    const calls = installFetch(() => json(200, CANCELLED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    startCancel();
    confirmCancel();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(
      `/api/backend/maintenance/${MAINTENANCE_ID}/cancel`,
    );
    expect(calls[0]!.method).toBe('POST');
    // Not even an empty object, and so no content-type header either.
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers).toBeUndefined();
  });

  it('offers no reason field', () => {
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    startCancel();
    expect(screen.queryByLabelText(/reason/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('confirms success and hands the returned row upward', async () => {
    const onChanged = vi.fn();
    installFetch(() => json(200, CANCELLED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={onChanged}
        onStale={vi.fn()}
      />,
    );
    startCancel();
    confirmCancel();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Maintenance cancelled.',
    );
    expect(onChanged).toHaveBeenCalledWith(CANCELLED_ROW);
  });
});

describe('MaintenanceActions lost races', () => {
  it('reports a lost completion and asks the parent to reload', async () => {
    const onChanged = vi.fn();
    const onStale = vi.fn();
    installFetch(() =>
      json(409, { statusCode: 409, message: 'maintenance_not_completable' }),
    );
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={onChanged}
        onStale={onStale}
      />,
    );
    startComplete();
    fillCompletion('2026-09-25T10:00', '');
    confirmComplete();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This maintenance record can no longer be completed. Refresh to see its current status.',
    );
    // Which terminal state won is the API's to say.
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Confirm completion' }),
    ).not.toBeInTheDocument();
  });

  it('reports a lost cancellation and asks the parent to reload', async () => {
    const onChanged = vi.fn();
    const onStale = vi.fn();
    installFetch(() =>
      json(409, { statusCode: 409, message: 'maintenance_not_cancellable' }),
    );
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={onChanged}
        onStale={onStale}
      />,
    );
    startCancel();
    confirmCancel();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This maintenance record can no longer be cancelled. Refresh to see its current status.',
    );
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('reports a vanished record without claiming a terminal state', async () => {
    const onStale = vi.fn();
    installFetch(() =>
      json(404, { statusCode: 404, message: 'maintenance_not_found' }),
    );
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={onStale}
      />,
    );
    startCancel();
    confirmCancel();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This maintenance record no longer exists.',
    );
    // Not the cancellable conflict, so no reload is requested from here.
    expect(onStale).not.toHaveBeenCalled();
  });

  it('never calls the vehicle status endpoint', async () => {
    const calls = installFetch(() => json(200, COMPLETED_ROW));
    render(
      <MaintenanceActions
        record={OPEN_RECORD}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    startComplete();
    fillCompletion('2026-09-25T10:00', '');
    confirmComplete();

    await waitFor(() => expect(calls).toHaveLength(1));
    // Finishing a job does not put a truck back into service (ADR 0010).
    expect(calls[0]!.url).not.toContain('/status');
    expect(calls[0]!.url).not.toContain('/vehicles/');
  });
});
