import { ApiError } from '@mansar/api-client';
import {
  EXPENSE_CATEGORIES,
  type Expense,
  type Page,
  type TripStatus,
} from '@mansar/types';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

import type { DriverExpensesApi } from './driver-expenses-api';
import { TripExpensesSection } from './TripExpensesSection';

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const EXPENSE_ID = '019a0000-0000-7000-8000-000000000002';

const expense = (overrides: Partial<Expense> = {}): Expense => ({
  id: EXPENSE_ID,
  tripId: TRIP_ID,
  status: 'SUBMITTED',
  amount: '1250.00',
  category: 'FUEL',
  incurredAt: '2026-09-24T00:30:00.000Z',
  description: 'Synthetic fuel stop',
  reviewNote: '',
  reviewedAt: null,
  createdAt: '2026-09-24T01:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z',
  ...overrides,
});

const pageOf = (items: Expense[], total = items.length): Page<Expense> => ({
  items,
  page: 1,
  pageSize: 25,
  total,
});

function fakeApi(overrides: Partial<DriverExpensesApi> = {}) {
  const api: DriverExpensesApi = {
    list: jest.fn(() => Promise.resolve(pageOf([]))),
    get: jest.fn(() => Promise.resolve(expense())),
    create: jest.fn(() => Promise.resolve(expense())),
    ...overrides,
  };
  return api;
}

async function renderSection(
  api: DriverExpensesApi,
  status: TripStatus = 'IN_PROGRESS',
  onOpenExpense = jest.fn(),
) {
  await render(
    <TripExpensesSection
      api={api}
      onOpenExpense={onOpenExpense}
      tripId={TRIP_ID}
      tripStatus={status}
    />,
  );
  return onOpenExpense;
}

const httpError = (status: number, code: string) =>
  new ApiError('http', { status, code });

/** Fills the form with a valid entry. */
async function fillForm(amount = '1250.00', at = '2026-09-24 08:30') {
  await fireEvent.changeText(screen.getByLabelText('Amount (PHP)'), amount);
  await fireEvent.changeText(
    screen.getByLabelText('Incurred at (Asia/Manila)'),
    at,
  );
}

describe('TripExpensesSection listing', () => {
  it('shows a loading state until the page arrives', async () => {
    let resolve!: (value: Page<Expense>) => void;
    const api = fakeApi({
      list: () =>
        new Promise<Page<Expense>>((settle) => {
          resolve = settle;
        }),
    });
    await renderSection(api);
    expect(screen.getByLabelText('Loading expenses')).toBeOnTheScreen();

    resolve(pageOf([]));
    expect(
      await screen.findByText('No expenses filed on this trip.'),
    ).toBeOnTheScreen();
  });

  it('asks for exactly one trip-scoped page', async () => {
    const list = jest.fn(() => Promise.resolve(pageOf([expense()])));
    await renderSection(fakeApi({ list }));
    await screen.findByText('₱1,250.00');
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(TRIP_ID, { page: 1, pageSize: 25 });
  });

  it('shows the amount, time, category and status of each row', async () => {
    await renderSection(
      fakeApi({ list: () => Promise.resolve(pageOf([expense()])) }),
    );
    expect(await screen.findByText('₱1,250.00')).toBeOnTheScreen();
    expect(screen.getByText('2026-09-24 08:30 Asia/Manila')).toBeOnTheScreen();
    expect(screen.getByText('FUEL · SUBMITTED')).toBeOnTheScreen();
  });

  it('formats the amount from the exact decimal string', async () => {
    await renderSection(
      fakeApi({
        list: () =>
          Promise.resolve(pageOf([expense({ amount: '1000000.05' })])),
      }),
    );
    expect(await screen.findByText('₱1,000,000.05')).toBeOnTheScreen();
  });

  it('states the server total rather than counting the page', async () => {
    await renderSection(
      fakeApi({ list: () => Promise.resolve(pageOf([expense()], 42)) }),
    );
    expect(
      await screen.findByText('42 expenses on this trip'),
    ).toBeOnTheScreen();
  });

  it('opens one expense when its row is pressed', async () => {
    const onOpen = await renderSection(
      fakeApi({ list: () => Promise.resolve(pageOf([expense()])) }),
    );
    await screen.findByText('₱1,250.00');
    await fireEvent.press(screen.getByText('₱1,250.00'));
    expect(onOpen).toHaveBeenCalledWith(EXPENSE_ID);
  });

  it('reports a failure safely and offers a retry', async () => {
    const list = jest
      .fn<Promise<Page<Expense>>, unknown[]>()
      .mockRejectedValueOnce(new ApiError('network'))
      .mockResolvedValueOnce(pageOf([expense()]));
    await renderSection(fakeApi({ list }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to reach the server. Try again.',
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('₱1,250.00')).toBeOnTheScreen();
  });

  it('never echoes raw server text', async () => {
    await renderSection(
      fakeApi({
        list: () =>
          Promise.reject(httpError(500, 'PrismaClientKnownRequestError')),
      }),
    );
    await screen.findByRole('alert');
    const shown = JSON.stringify(screen.toJSON());
    expect(shown).not.toMatch(/Prisma|statusCode|P2002/);
  });
});

describe('TripExpensesSection creation eligibility', () => {
  it.each(['IN_PROGRESS', 'COMPLETED'] as const)(
    'offers the form while %s',
    async (status) => {
      await renderSection(fakeApi(), status);
      await screen.findByText('No expenses filed on this trip.');
      expect(screen.getByLabelText('Amount (PHP)')).toBeOnTheScreen();
      expect(
        screen.getByRole('button', { name: 'Add expense' }),
      ).toBeOnTheScreen();
    },
  );

  it.each(['DRAFT', 'ASSIGNED', 'VERIFIED', 'CLOSED', 'CANCELLED'] as const)(
    'offers no form while %s',
    async (status) => {
      await renderSection(fakeApi(), status);
      await screen.findByText('No expenses filed on this trip.');
      // The API refuses these states, so the form is absent rather than
      // disabled, and no local rule broadens what the server allows.
      expect(screen.queryByLabelText('Amount (PHP)')).toBeNull();
      expect(screen.queryByLabelText('Description')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Add expense' })).toBeNull();
    },
  );
});

describe('TripExpensesSection form', () => {
  it('offers exactly the four contract fields', async () => {
    await renderSection(fakeApi());
    await screen.findByText('No expenses filed on this trip.');

    expect(screen.getByLabelText('Amount (PHP)')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Incurred at (Asia/Manila)'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Description')).toBeOnTheScreen();
    for (const category of EXPENSE_CATEGORIES) {
      expect(screen.getByLabelText(`Category ${category}`)).toBeOnTheScreen();
    }
    // Nothing the backend has no field for.
    for (const absent of [
      'Vendor',
      'Payee',
      'Receipt number',
      'Currency',
      'Driver',
      'Review note',
      'Status',
      'Trip',
    ]) {
      expect(screen.queryByLabelText(absent)).toBeNull();
    }
  });

  it('uses a decimal keypad and holds the amount as a string', async () => {
    await renderSection(fakeApi());
    await screen.findByText('No expenses filed on this trip.');
    const input = screen.getByLabelText('Amount (PHP)');
    expect(input.props.keyboardType).toBe('decimal-pad');

    await fireEvent.changeText(input, '1250.00');
    expect(input.props.value).toBe('1250.00');
    expect(typeof input.props.value).toBe('string');
  });

  it('caps the description at the length the API enforces', async () => {
    await renderSection(fakeApi());
    await screen.findByText('No expenses filed on this trip.');
    const input = screen.getByLabelText('Description');
    expect(input.props.maxLength).toBe(500);
    expect(input.props.multiline).toBe(true);
  });

  it('defaults the incurred time to a value its own parser accepts', async () => {
    await renderSection(fakeApi());
    await screen.findByText('No expenses filed on this trip.');
    const value = String(
      screen.getByLabelText('Incurred at (Asia/Manila)').props.value,
    );
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('sends exactly the four fields, with the Manila offset applied', async () => {
    const create = jest.fn(() => Promise.resolve(expense()));
    await renderSection(fakeApi({ create }));
    await screen.findByText('No expenses filed on this trip.');

    await fillForm('1250.00', '2026-09-24 08:30');
    await fireEvent.press(screen.getByLabelText('Category TOLL'));
    await fireEvent.changeText(
      screen.getByLabelText('Description'),
      'Synthetic toll',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Add expense' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(TRIP_ID, {
      amount: '1250.00',
      category: 'TOLL',
      incurredAt: '2026-09-24T08:30:00+08:00',
      description: 'Synthetic toll',
    });
  });

  it('defaults the category to FUEL and sends the chosen one', async () => {
    const create = jest.fn(() => Promise.resolve(expense()));
    await renderSection(fakeApi({ create }));
    await screen.findByText('No expenses filed on this trip.');
    await fillForm();
    await fireEvent.press(screen.getByRole('button', { name: 'Add expense' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      TRIP_ID,
      expect.objectContaining({ category: 'FUEL' }),
    );
  });

  it.each(EXPENSE_CATEGORIES)('can send the %s category', async (category) => {
    const create = jest.fn(() => Promise.resolve(expense()));
    await renderSection(fakeApi({ create }));
    await screen.findByText('No expenses filed on this trip.');
    await fillForm();
    await fireEvent.press(screen.getByLabelText(`Category ${category}`));
    await fireEvent.press(screen.getByRole('button', { name: 'Add expense' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      TRIP_ID,
      expect.objectContaining({ category }),
    );
  });
});

describe('TripExpensesSection validation', () => {
  it.each([
    ['an empty amount', ''],
    ['zero', '0'],
    ['zero with decimals', '0.00'],
    ['a leading zero', '01.00'],
    ['three decimals', '1.005'],
    ['exponent notation', '1e3'],
    ['a negative amount', '-5'],
    ['a thousands separator', '1,250.00'],
    ['whitespace', ' 1.00'],
    ['free text', 'twelve'],
  ])('refuses %s without calling the API', async (_label, amount) => {
    const create = jest.fn(() => Promise.resolve(expense()));
    await renderSection(fakeApi({ create }));
    await screen.findByText('No expenses filed on this trip.');

    await fillForm(amount);
    await fireEvent.press(screen.getByRole('button', { name: 'Add expense' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter an amount greater than zero, with at most two decimal places.',
    );
    // A round trip to be told what we already know is worse than saying it.
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty time', ''],
    ['a bare date', '2026-09-24'],
    ['29 February in a non-leap year', '2026-02-29 08:30'],
    ['hour 24', '2026-09-24 24:00'],
    ['minute 60', '2026-09-24 08:60'],
    ['seconds included', '2026-09-24 08:30:00'],
    ['free text', 'this morning'],
  ])('refuses %s without calling the API', async (_label, at) => {
    const create = jest.fn(() => Promise.resolve(expense()));
    await renderSection(fakeApi({ create }));
    await screen.findByText('No expenses filed on this trip.');

    await fillForm('1250.00', at);
    await fireEvent.press(screen.getByRole('button', { name: 'Add expense' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter the time it was incurred as YYYY-MM-DD HH:MM.',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['1', '1'],
    ['1.0', '1.0'],
    ['1.00', '1.00'],
    ['0.01', '0.01'],
    ['9999999999.99', '9999999999.99'],
  ])('accepts %s', async (_label, amount) => {
    const create = jest.fn(() => Promise.resolve(expense()));
    await renderSection(fakeApi({ create }));
    await screen.findByText('No expenses filed on this trip.');
    await fillForm(amount);
    await fireEvent.press(screen.getByRole('button', { name: 'Add expense' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      TRIP_ID,
      expect.objectContaining({ amount }),
    );
  });
});

describe('TripExpensesSection submission', () => {
  it('sends exactly one request however often the button is pressed', async () => {
    let settle!: (value: Expense) => void;
    const create = jest.fn(
      () =>
        new Promise<Expense>((resolve) => {
          settle = resolve;
        }),
    );
    await renderSection(fakeApi({ create }));
    await screen.findByText('No expenses filed on this trip.');
    await fillForm();

    const button = screen.getByRole('button', { name: 'Add expense' });
    await fireEvent.press(button);
    await fireEvent.press(screen.getByRole('button', { busy: true }));
    await fireEvent.press(screen.getByRole('button', { busy: true }));
    expect(create).toHaveBeenCalledTimes(1);

    settle(expense());
    await waitFor(() =>
      expect(screen.getByText('Expense filed.')).toBeTruthy(),
    );
  });

  it('re-reads the authoritative list instead of splicing a row', async () => {
    const list = jest
      .fn<Promise<Page<Expense>>, unknown[]>()
      .mockResolvedValueOnce(pageOf([]))
      .mockResolvedValueOnce(pageOf([expense()]));
    const create = jest.fn(() => Promise.resolve(expense({ amount: '9.99' })));
    await renderSection(fakeApi({ list, create }));
    await screen.findByText('No expenses filed on this trip.');

    await fillForm();
    await fireEvent.press(screen.getByRole('button', { name: 'Add expense' }));

    // The row that appears is the server's, not the 201 body echoed back.
    expect(await screen.findByText('₱1,250.00')).toBeOnTheScreen();
    expect(screen.queryByText('₱9.99')).toBeNull();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('clears the amount and description after a successful create', async () => {
    await renderSection(fakeApi());
    await screen.findByText('No expenses filed on this trip.');
    await fillForm();
    await fireEvent.changeText(screen.getByLabelText('Description'), 'note');
    await fireEvent.press(screen.getByRole('button', { name: 'Add expense' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Amount (PHP)').props.value).toBe(''),
    );
    expect(screen.getByLabelText('Description').props.value).toBe('');
  });

  it.each([
    [
      'trip_not_expensable',
      409,
      'Expenses can only be filed while a trip is in progress or completed.',
    ],
    ['trip_not_found', 404, 'This trip is no longer available.'],
    [
      'driver_not_linked',
      409,
      'Your account is not linked to a driver profile.',
    ],
  ])('maps the %s refusal safely', async (code, status, message) => {
    await renderSection(
      fakeApi({ create: () => Promise.reject(httpError(status, code)) }),
    );
    await screen.findByText('No expenses filed on this trip.');
    await fillForm();
    await fireEvent.press(screen.getByRole('button', { name: 'Add expense' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    // The form keeps what the driver typed so they can act on the message.
    expect(screen.getByLabelText('Amount (PHP)').props.value).toBe('1250.00');
  });

  it('lets the driver try again after a failure', async () => {
    const create = jest
      .fn<Promise<Expense>, unknown[]>()
      .mockRejectedValueOnce(new ApiError('network'))
      .mockResolvedValueOnce(expense());
    await renderSection(fakeApi({ create }));
    await screen.findByText('No expenses filed on this trip.');
    await fillForm();
    await fireEvent.press(screen.getByRole('button', { name: 'Add expense' }));
    await screen.findByRole('alert');

    await fireEvent.press(screen.getByRole('button', { name: 'Add expense' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });
});
