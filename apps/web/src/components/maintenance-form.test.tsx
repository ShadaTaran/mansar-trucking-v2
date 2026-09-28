import { MAINTENANCE_CATEGORIES } from '@mansar/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { MaintenanceForm } from './maintenance-form';

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

const COMPLETED_RECORD = {
  ...OPEN_RECORD,
  status: 'COMPLETED' as const,
  completedAt: '2026-09-25T02:00:00.000Z',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
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
      });
      return handler();
    }),
  );
  return calls;
}

/**
 * Submits by dispatching the form's own submit event.
 *
 * Clicking the button runs the browser's constraint validation first, and the
 * fields carry `required` and `pattern`, so a malformed entry never reaches the
 * handler that way. The handler must not *depend* on those attributes — they
 * are trivially removable and absent in any non-browser caller — so its own
 * guards are exercised through this path, and the field-level block is
 * asserted separately.
 */
function submitDirectly() {
  fireEvent.submit(
    screen
      .getByRole('button', { name: /Add maintenance|Save changes/ })
      .closest('form')!,
  );
}

function fillCreate({
  startedAt = '2026-09-24T08:30',
  description = 'Synthetic preventive service',
  odometer = '',
  cost = '',
  category,
}: {
  startedAt?: string;
  description?: string;
  odometer?: string;
  cost?: string;
  category?: string;
} = {}) {
  if (category !== undefined) {
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: category },
    });
  }
  fireEvent.change(screen.getByLabelText('Started at (Asia/Manila)'), {
    target: { value: startedAt },
  });
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: description },
  });
  fireEvent.change(screen.getByLabelText('Odometer'), {
    target: { value: odometer },
  });
  fireEvent.change(screen.getByLabelText('Cost (PHP)'), {
    target: { value: cost },
  });
}

const clickCreate = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Add maintenance' }));
const clickSave = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

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

describe('MaintenanceForm fields', () => {
  it('offers exactly the five fields the API accepts', () => {
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);

    expect(screen.getByLabelText('Category')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Started at (Asia/Manila)'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByLabelText('Odometer')).toBeInTheDocument();
    expect(screen.getByLabelText('Cost (PHP)')).toBeInTheDocument();

    // Everything the API refuses to be told, plus the things this stage does
    // not implement at all.
    for (const label of [
      /status/i,
      /completed/i,
      /vehicle/i,
      /vendor/i,
      /shop/i,
      /schedule/i,
      /attachment/i,
      /photo/i,
      /trip/i,
      /driver/i,
    ]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
  });

  it('offers exactly the frozen category tuple, with no All option', () => {
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    expect(
      Array.from(
        screen.getByLabelText('Category').querySelectorAll('option'),
      ).map((option) => option.textContent),
    ).toEqual([...MAINTENANCE_CATEGORIES]);
    expect(screen.getByLabelText('Category')).toHaveValue(
      MAINTENANCE_CATEGORIES[0],
    );
  });

  it('caps the description at the length the API enforces', () => {
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('Description')).toHaveAttribute(
      'maxlength',
      '2000',
    );
  });

  it('keeps the cost a text field so no float can enter the money path', () => {
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    const cost = screen.getByLabelText('Cost (PHP)');
    expect(cost).toHaveAttribute('type', 'text');
    expect(cost).toHaveAttribute('inputmode', 'decimal');
    // `type="number"` would expose valueAsNumber and stepper semantics.
    expect(cost).not.toHaveAttribute('type', 'number');
  });

  it('keeps the odometer a text field, entered as digits', () => {
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    const odometer = screen.getByLabelText('Odometer');
    expect(odometer).toHaveAttribute('type', 'text');
    expect(odometer).toHaveAttribute('inputmode', 'numeric');
  });
});

describe('MaintenanceForm create', () => {
  it('posts to the vehicle route with the vehicle only in the path', async () => {
    const calls = installFetch(() => json(201, OPEN_RECORD));
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    fillCreate({ category: 'INSPECTION' });
    clickCreate();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(
      `/api/backend/vehicles/${VEHICLE_ID}/maintenance`,
    );
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      category: 'INSPECTION',
      startedAt: '2026-09-24T00:30:00.000Z',
      description: 'Synthetic preventive service',
    });
    expect(calls[0]!.body).not.toHaveProperty('vehicleId');
    expect(calls[0]!.body).not.toHaveProperty('status');
    expect(calls[0]!.body).not.toHaveProperty('completedAt');
  });

  it('converts the started instant as Manila wall-clock, not browser time', async () => {
    const calls = installFetch(() => json(201, OPEN_RECORD));
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    fillCreate({ startedAt: '2026-12-31T23:45' });
    clickCreate();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]!.body as { startedAt: string }).startedAt).toBe(
      '2026-12-31T15:45:00.000Z',
    );
  });

  it('omits the optional fields when they are left blank', async () => {
    const calls = installFetch(() => json(201, OPEN_RECORD));
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    fillCreate({ odometer: '', cost: '' });
    clickCreate();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual([
      'category',
      'description',
      'startedAt',
    ]);
  });

  it('sends the odometer as an integer', async () => {
    const calls = installFetch(() => json(201, OPEN_RECORD));
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    fillCreate({ odometer: '125000' });
    clickCreate();

    await waitFor(() => expect(calls).toHaveLength(1));
    const body = calls[0]!.body as { odometer: number };
    expect(body.odometer).toBe(125000);
    expect(typeof body.odometer).toBe('number');
    expect(Number.isInteger(body.odometer)).toBe(true);
  });

  it('sends a zero odometer rather than treating it as blank', async () => {
    const calls = installFetch(() => json(201, OPEN_RECORD));
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    fillCreate({ odometer: '0' });
    clickCreate();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]!.body as { odometer: number }).odometer).toBe(0);
  });

  it('accepts a zero cost, which an expense amount would refuse', async () => {
    const calls = installFetch(() => json(201, OPEN_RECORD));
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    fillCreate({ cost: '0.00' });
    clickCreate();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]!.body as { cost: string }).cost).toBe('0.00');
  });

  it.each(['0', '0.0', '0.00', '99.5', '99.50', '9999999999.99'])(
    'sends the cost %s as the exact string that was typed',
    async (cost) => {
      const calls = installFetch(() => json(201, OPEN_RECORD));
      render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
      fillCreate({ cost });
      clickCreate();

      await waitFor(() => expect(calls).toHaveLength(1));
      const body = calls[0]!.body as { cost: unknown };
      // Byte-identical: never re-formatted and never through a float.
      expect(body.cost).toBe(cost);
      expect(typeof body.cost).toBe('string');
    },
  );

  it('keeps a cost a float would round wrong', async () => {
    const calls = installFetch(() => json(201, OPEN_RECORD));
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    fillCreate({ cost: '1234567.89' });
    clickCreate();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]!.body as { cost: string }).cost).toBe('1234567.89');
  });

  it('confirms success, clears the form and hands over the created record', async () => {
    const onSaved = vi.fn();
    installFetch(() => json(201, OPEN_RECORD));
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={onSaved} />);
    fillCreate({ odometer: '125000', cost: '12500.00' });
    clickCreate();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Maintenance record created.',
    );
    // The authoritative row, not a locally assembled one.
    expect(onSaved).toHaveBeenCalledWith(OPEN_RECORD);
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(screen.getByLabelText('Odometer')).toHaveValue('');
    expect(screen.getByLabelText('Cost (PHP)')).toHaveValue('');
  });

  it('keeps what was typed when the server refuses', async () => {
    const onSaved = vi.fn();
    installFetch(() =>
      json(404, { statusCode: 404, message: 'vehicle_not_found' }),
    );
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={onSaved} />);
    fillCreate({ odometer: '125000', cost: '12500.00' });
    clickCreate();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This vehicle no longer exists.',
    );
    expect(screen.getByLabelText('Odometer')).toHaveValue('125000');
    expect(screen.getByLabelText('Cost (PHP)')).toHaveValue('12500.00');
    expect(screen.getByLabelText('Description')).toHaveValue(
      'Synthetic preventive service',
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('lists the server validation messages under the error', async () => {
    installFetch(() =>
      json(400, {
        statusCode: 400,
        message: ['cost must be a decimal string or null'],
      }),
    );
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    fillCreate();
    clickCreate();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Please check the values you entered.');
    expect(alert).toHaveTextContent('cost must be a decimal string or null');
  });
});

describe('MaintenanceForm client-side validation', () => {
  it.each([
    ['a fractional odometer', '1.5'],
    ['a negative odometer', '-1'],
    ['an exponent odometer', '1e3'],
    ['a decimal-point odometer', '125000.0'],
    ['a separated odometer', '125,000'],
    ['free text', 'abc'],
  ])('refuses %s without making a request', async (_label, odometer) => {
    const calls = installFetch(() => json(201, OPEN_RECORD));
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    fillCreate({ odometer });
    clickCreate();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter the odometer as a whole number, or leave it blank.',
    );
    // Nothing is silently coerced into an integer.
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['three decimal places', '1.005'],
    ['a negative cost', '-1'],
    ['an explicit plus', '+1'],
    ['exponent notation', '1e3'],
    ['a trailing dot', '10.'],
    ['a leading dot', '.50'],
    ['a thousands separator', '1,250.00'],
    ['a currency sign', '₱1.00'],
    ['eleven integer digits', '10000000000'],
    ['a leading-zero run', '0100'],
  ])('refuses %s as a cost without making a request', async (_label, cost) => {
    const calls = installFetch(() => json(201, OPEN_RECORD));
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    fillCreate({ cost });
    submitDirectly();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a cost with at most two decimal places.',
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['three decimal places', '1.005'],
    ['a negative cost', '-1'],
    ['eleven integer digits', '10000000000'],
    ['a currency sign', '₱1.00'],
  ])(
    'also blocks %s at the field itself, before any handler runs',
    async (_label, cost) => {
      const calls = installFetch(() => json(201, OPEN_RECORD));
      render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
      fillCreate({ cost });
      clickCreate();

      // The field's own pattern refuses it, so the submit never happens and
      // no alert is needed — either way nothing reaches the API.
      await waitFor(() => expect(calls).toHaveLength(0));
      expect(screen.getByLabelText('Cost (PHP)')).toBeInvalid();
    },
  );

  it('refuses a submit whose started instant will not convert', async () => {
    const calls = installFetch(() => json(201, OPEN_RECORD));
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    // A datetime-local input refuses to hold an impossible date at all, so the
    // field stays empty; submitting the form directly is how a submit that
    // already cleared the browser's own validation arrives here.
    fireEvent.change(screen.getByLabelText('Started at (Asia/Manila)'), {
      target: { value: '2026-02-30T08:00' },
    });
    expect(screen.getByLabelText('Started at (Asia/Manila)')).toHaveValue('');
    submitDirectly();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a valid date and time.',
    );
    expect(calls).toHaveLength(0);
  });

  it('marks the started instant required so a blank never reaches the API', () => {
    render(<MaintenanceForm vehicleId={VEHICLE_ID} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('Started at (Asia/Manila)')).toBeRequired();
  });
});

describe('MaintenanceForm edit', () => {
  it('prepopulates every field from the stored record', () => {
    render(
      <MaintenanceForm
        record={OPEN_RECORD}
        onSaved={vi.fn()}
        onStale={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Category')).toHaveValue('REPAIR');
    // ISO in UTC becomes the Manila wall-clock a datetime-local expects.
    expect(screen.getByLabelText('Started at (Asia/Manila)')).toHaveValue(
      '2026-09-24T08:30',
    );
    expect(screen.getByLabelText('Description')).toHaveValue(
      'Synthetic brake overhaul',
    );
    expect(screen.getByLabelText('Odometer')).toHaveValue('125000');
    expect(screen.getByLabelText('Cost (PHP)')).toHaveValue('12500.00');
  });

  it('shows blanks for an absent odometer and cost', () => {
    render(
      <MaintenanceForm
        record={{ ...OPEN_RECORD, odometer: null, cost: null }}
        onSaved={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Odometer')).toHaveValue('');
    expect(screen.getByLabelText('Cost (PHP)')).toHaveValue('');
  });

  it('patches only the field that changed', async () => {
    const calls = installFetch(() =>
      json(200, { ...OPEN_RECORD, description: 'Synthetic note' }),
    );
    render(
      <MaintenanceForm
        record={OPEN_RECORD}
        onSaved={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Synthetic note' },
    });
    clickSave();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`/api/backend/maintenance/${MAINTENANCE_ID}`);
    expect(calls[0]!.method).toBe('PATCH');
    // Not all five stored values: resending them would re-assert facts the
    // admin never touched, overwriting anyone else's correction.
    expect(calls[0]!.body).toEqual({ description: 'Synthetic note' });
  });

  it('patches a changed category alone', async () => {
    const calls = installFetch(() => json(200, OPEN_RECORD));
    render(
      <MaintenanceForm
        record={OPEN_RECORD}
        onSaved={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'TIRE' },
    });
    clickSave();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ category: 'TIRE' });
  });

  it('patches a changed start instant as a converted ISO value', async () => {
    const calls = installFetch(() => json(200, OPEN_RECORD));
    render(
      <MaintenanceForm
        record={OPEN_RECORD}
        onSaved={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Started at (Asia/Manila)'), {
      target: { value: '2026-09-25T09:15' },
    });
    clickSave();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({
      startedAt: '2026-09-25T01:15:00.000Z',
    });
  });

  it('sends an explicit null when the cost is cleared', async () => {
    const calls = installFetch(() => json(200, { ...OPEN_RECORD, cost: null }));
    render(
      <MaintenanceForm
        record={OPEN_RECORD}
        onSaved={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Cost (PHP)'), {
      target: { value: '' },
    });
    clickSave();

    await waitFor(() => expect(calls).toHaveLength(1));
    // An omitted key would leave the stored cost alone; null clears it.
    expect(calls[0]!.body).toEqual({ cost: null });
  });

  it('sends an explicit null when the odometer is cleared', async () => {
    const calls = installFetch(() =>
      json(200, { ...OPEN_RECORD, odometer: null }),
    );
    render(
      <MaintenanceForm
        record={OPEN_RECORD}
        onSaved={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Odometer'), {
      target: { value: '' },
    });
    clickSave();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ odometer: null });
  });

  it('sends both cleared values together', async () => {
    const calls = installFetch(() =>
      json(200, { ...OPEN_RECORD, odometer: null, cost: null }),
    );
    render(
      <MaintenanceForm
        record={OPEN_RECORD}
        onSaved={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Odometer'), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByLabelText('Cost (PHP)'), {
      target: { value: '' },
    });
    clickSave();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ odometer: null, cost: null });
  });

  it('makes no request at all when nothing changed', async () => {
    const calls = installFetch(() => json(200, OPEN_RECORD));
    render(
      <MaintenanceForm
        record={OPEN_RECORD}
        onSaved={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    clickSave();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'No changes to save.',
    );
    // The API refuses an empty patch; saying so costs no round trip.
    expect(calls).toHaveLength(0);
  });

  it('uses the returned record as the new baseline rather than a local merge', async () => {
    const onSaved = vi.fn();
    const calls = installFetch(() =>
      json(200, {
        ...OPEN_RECORD,
        description: 'Synthetic note',
        updatedAt: '2026-09-26T03:00:00.000Z',
      }),
    );
    render(
      <MaintenanceForm
        record={OPEN_RECORD}
        onSaved={onSaved}
        onStale={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Synthetic note' },
    });
    clickSave();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Maintenance record updated.',
    );
    expect(onSaved).toHaveBeenCalledWith({
      ...OPEN_RECORD,
      description: 'Synthetic note',
      updatedAt: '2026-09-26T03:00:00.000Z',
    });

    // Re-baselined from that row: saving again with no further edit is a
    // no-op, which it would not be if the baseline were still the old record.
    clickSave();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'No changes to save.',
      ),
    );
    expect(calls).toHaveLength(1);
  });

  it('asks the parent to reload when the record is no longer editable', async () => {
    const onSaved = vi.fn();
    const onStale = vi.fn();
    installFetch(() =>
      json(409, { statusCode: 409, message: 'maintenance_not_editable' }),
    );
    render(
      <MaintenanceForm
        record={OPEN_RECORD}
        onSaved={onSaved}
        onStale={onStale}
      />,
    );
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Synthetic note' },
    });
    clickSave();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This maintenance record can no longer be edited. Refresh to see its current status.',
    );
    // Which terminal state won is the API's answer to give, not a local guess.
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('does not ask for a reload on an ordinary validation failure', async () => {
    const onStale = vi.fn();
    installFetch(() =>
      json(400, { statusCode: 400, message: ['at least one field'] }),
    );
    render(
      <MaintenanceForm
        record={OPEN_RECORD}
        onSaved={vi.fn()}
        onStale={onStale}
      />,
    );
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Synthetic note' },
    });
    clickSave();

    await screen.findByRole('alert');
    expect(onStale).not.toHaveBeenCalled();
  });

  it.each(['COMPLETED', 'CANCELLED'] as const)(
    'renders nothing for a %s record',
    (status) => {
      const { container } = render(
        <MaintenanceForm
          record={{ ...COMPLETED_RECORD, status }}
          onSaved={vi.fn()}
          onStale={vi.fn()}
        />,
      );
      // Terminal records are read-only: an edit form there could only ever
      // produce a doomed request.
      expect(container).toBeEmptyDOMElement();
      expect(
        screen.queryByRole('button', { name: 'Save changes' }),
      ).not.toBeInTheDocument();
    },
  );

  it('never offers a delete or a reopen', () => {
    render(
      <MaintenanceForm
        record={OPEN_RECORD}
        onSaved={vi.fn()}
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

  it('never touches the vehicle status endpoint', async () => {
    const calls = installFetch(() => json(200, OPEN_RECORD));
    render(
      <MaintenanceForm
        record={OPEN_RECORD}
        onSaved={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'OTHER' },
    });
    clickSave();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).not.toContain('/status');
    expect(calls[0]!.url).not.toContain('/vehicles/');
  });
});
