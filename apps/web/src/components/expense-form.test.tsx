import { EXPENSE_CATEGORIES } from '@mansar/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { ExpenseForm } from './expense-form';

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const EXPENSE_ID = '019a0000-0000-7000-8000-000000000002';

const CREATED = {
  id: EXPENSE_ID,
  tripId: TRIP_ID,
  status: 'SUBMITTED',
  amount: '1250.00',
  category: 'FUEL',
  incurredAt: '2026-09-24T00:30:00.000Z',
  description: 'Fuel stop',
  reviewNote: '',
  reviewedAt: null,
  createdAt: '2026-09-24T01:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z',
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

/** Fills the whole form with a valid entry, then submits. */
function fillAndSubmit(amount = '1250.00', incurredAt = '2026-09-24T08:30') {
  fireEvent.change(screen.getByLabelText('Amount (PHP)'), {
    target: { value: amount },
  });
  fireEvent.change(screen.getByLabelText('Incurred at (Asia/Manila)'), {
    target: { value: incurredAt },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add expense' }));
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

describe('ExpenseForm fields', () => {
  it('offers exactly the four fields the API accepts', () => {
    render(<ExpenseForm tripId={TRIP_ID} onCreated={vi.fn()} />);

    expect(screen.getByLabelText('Amount (PHP)')).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Incurred at (Asia/Manila)'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();

    // Everything the API refuses to be told is absent.
    for (const label of [
      /currency/i,
      /driver/i,
      /receipt/i,
      /status/i,
      /review note/i,
      /vendor/i,
    ]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
  });

  it('builds the category list from the shared tuple', () => {
    render(<ExpenseForm tripId={TRIP_ID} onCreated={vi.fn()} />);
    const options = screen
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual([...EXPENSE_CATEGORIES]);
  });

  it('takes the amount as text, never as a number input', () => {
    render(<ExpenseForm tripId={TRIP_ID} onCreated={vi.fn()} />);
    const amount = screen.getByLabelText('Amount (PHP)');
    // type="number" would expose valueAsNumber and step semantics, which
    // is exactly the float path this app refuses for money.
    expect(amount).toHaveAttribute('type', 'text');
    expect(amount).toHaveAttribute('inputMode', 'decimal');
  });

  it('caps the description at the API limit', () => {
    render(<ExpenseForm tripId={TRIP_ID} onCreated={vi.fn()} />);
    expect(screen.getByLabelText('Description')).toHaveAttribute(
      'maxLength',
      '500',
    );
  });
});

describe('ExpenseForm amount handling', () => {
  it.each(['1', '1.0', '1.00', '0.01', '99.5', '9999999999.99'])(
    'accepts %s and sends it as the exact string typed',
    async (amount) => {
      const calls = installFetch(() => json(201, CREATED));
      render(<ExpenseForm tripId={TRIP_ID} onCreated={vi.fn()} />);
      fillAndSubmit(amount);

      await waitFor(() => expect(calls).toHaveLength(1));
      const body = calls[0]!.body as { amount: unknown };
      expect(body.amount).toBe(amount);
      expect(typeof body.amount).toBe('string');
    },
  );

  /**
   * Two gates gate the amount, and they catch different things.
   *
   * The `pattern` attribute is the first: the browser refuses to submit a
   * shape it does not match, so the handler never runs. What it cannot
   * express is "greater than zero" — `0` and `0.00` match the pattern
   * perfectly — which is what the string-safe helper is for.
   */
  it.each([
    ['a negative amount', '-5.00'],
    ['three decimal places', '1.000'],
    ['exponent notation', '1e3'],
    ['free text', 'abc'],
    ['eleven integer digits', '10000000000'],
  ])('lets the input pattern block %s', async (_label, amount) => {
    const calls = installFetch(() => json(201, CREATED));
    render(<ExpenseForm tripId={TRIP_ID} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Amount (PHP)'), {
      target: { value: amount },
    });
    expect(
      (
        screen.getByLabelText('Amount (PHP)') as HTMLInputElement
      ).checkValidity(),
    ).toBe(false);

    fillAndSubmit(amount);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['zero', '0'],
    ['zero with decimals', '0.00'],
    ['a padded zero', '01.00'],
  ])(
    'rejects %s in the handler, which the pattern cannot catch',
    async (_label, amount) => {
      const calls = installFetch(() => json(201, CREATED));
      render(<ExpenseForm tripId={TRIP_ID} onCreated={vi.fn()} />);

      // The browser is happy with these; only the money rule is not.
      fireEvent.change(screen.getByLabelText('Amount (PHP)'), {
        target: { value: amount },
      });
      expect(
        (
          screen.getByLabelText('Amount (PHP)') as HTMLInputElement
        ).checkValidity(),
      ).toBe(true);

      fillAndSubmit(amount);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Enter an amount greater than zero, with at most two decimal places.',
      );
      expect(calls).toHaveLength(0);
    },
  );
});

describe('ExpenseForm submission', () => {
  it('posts to the trip-scoped route and accepts a 201', async () => {
    const calls = installFetch(() => json(201, CREATED));
    const onCreated = vi.fn();
    render(<ExpenseForm tripId={TRIP_ID} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'TOLL' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'North toll gate' },
    });
    fillAndSubmit();

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(CREATED));
    expect(calls[0]).toMatchObject({
      url: `/api/backend/trips/${TRIP_ID}/expenses`,
      method: 'POST',
      body: {
        amount: '1250.00',
        category: 'TOLL',
        // 08:30 Manila is 00:30 UTC.
        incurredAt: '2026-09-24T00:30:00.000Z',
        description: 'North toll gate',
      },
    });
  });

  it('converts the local instant as Manila wall-clock, not browser time', async () => {
    const calls = installFetch(() => json(201, CREATED));
    render(<ExpenseForm tripId={TRIP_ID} onCreated={vi.fn()} />);
    fillAndSubmit('10.00', '2026-12-31T23:45');

    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]!.body as { incurredAt: string }).incurredAt).toBe(
      '2026-12-31T15:45:00.000Z',
    );
  });

  it('never sends an impossible date', async () => {
    const calls = installFetch(() => json(201, CREATED));
    render(<ExpenseForm tripId={TRIP_ID} onCreated={vi.fn()} />);
    fillAndSubmit('10.00', '2026-02-30T08:00');

    // A datetime-local input refuses to hold 30 February at all, so the
    // field stays empty and `required` stops the submission.
    //
    // The handler's own manilaLocalToIso guard has no reachable path from
    // this UI for the same reason — the input only ever yields a
    // well-formed local instant — so it is defensive depth rather than
    // something this file can exercise. The conversion itself is covered
    // directly in lib/trip-time.test.ts.
    expect(screen.getByLabelText('Incurred at (Asia/Manila)')).toHaveValue('');
    expect(calls).toHaveLength(0);
  });

  it('confirms success and clears the form', async () => {
    installFetch(() => json(201, CREATED));
    render(<ExpenseForm tripId={TRIP_ID} onCreated={vi.fn()} />);
    fillAndSubmit();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Expense submitted for review.',
    );
    expect(screen.getByLabelText('Amount (PHP)')).toHaveValue('');
  });

  it('keeps what was typed when the server refuses', async () => {
    installFetch(() => json(409, { message: 'trip_not_expensable' }));
    render(<ExpenseForm tripId={TRIP_ID} onCreated={vi.fn()} />);
    fillAndSubmit('1250.00');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Expenses can only be added while this trip is completed and awaiting verification.',
    );
    expect(screen.getByLabelText('Amount (PHP)')).toHaveValue('1250.00');
  });

  it('lists server validation messages under the safe summary', async () => {
    installFetch(() =>
      json(400, { message: ['amount must be a decimal string'] }),
    );
    render(<ExpenseForm tripId={TRIP_ID} onCreated={vi.fn()} />);
    fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Please check the values you entered.');
    expect(alert).toHaveTextContent('amount must be a decimal string');
  });

  it('does not call onCreated when the server refuses', async () => {
    installFetch(() => json(409, { message: 'trip_not_expensable' }));
    const onCreated = vi.fn();
    render(<ExpenseForm tripId={TRIP_ID} onCreated={onCreated} />);
    fillAndSubmit();

    await screen.findByRole('alert');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('fails closed when the created expense does not parse', async () => {
    installFetch(() => json(201, { ...CREATED, amount: '1250' }));
    const onCreated = vi.fn();
    render(<ExpenseForm tripId={TRIP_ID} onCreated={onCreated} />);
    fillAndSubmit();

    await screen.findByRole('alert');
    expect(onCreated).not.toHaveBeenCalled();
  });
});
