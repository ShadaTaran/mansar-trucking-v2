import { ApiError } from '@mansar/api-client';
import type {
  Expense,
  ExpenseStatus,
  Receipt,
  ReceiptUploadAuthorization,
} from '@mansar/types';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

import type { DriverReceiptsApi } from '../receipts/driver-receipts-api';
import type { DriverExpensesApi } from './driver-expenses-api';
import { ExpenseDetailView } from './ExpenseDetailView';

const { __receiptPickerFake: picker } = jest.requireMock<
  typeof import('../specs/__mocks__/NativeReceiptPicker')
>('../specs/NativeReceiptPicker');

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const EXPENSE_ID = '019a0000-0000-7000-8000-000000000002';
const RECEIPT_ID = '019a0000-0000-7000-8000-000000000003';
const PICKED_URI = 'content://media/external/images/media/1234';
const SIGNED_READ_URL =
  'https://storage.example.test/read?signature=synthetic-read';

const expense = (
  status: ExpenseStatus = 'SUBMITTED',
  overrides: Partial<Expense> = {},
): Expense => ({
  id: EXPENSE_ID,
  tripId: TRIP_ID,
  status,
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

const pending: Receipt = {
  id: RECEIPT_ID,
  expenseId: EXPENSE_ID,
  contentType: 'image/jpeg',
  byteSize: 2048,
  confirmedAt: null,
  createdAt: '2026-09-24T01:00:00.000Z',
};

const confirmed: Receipt = {
  ...pending,
  confirmedAt: '2026-09-24T01:05:00.000Z',
};

const POST_AUTH: ReceiptUploadAuthorization = {
  receiptId: RECEIPT_ID,
  method: 'POST',
  url: 'https://storage.example.test/receipts',
  fields: { key: 'synthetic/key.jpg', policy: 'synthetic-policy' },
  expiresAt: '2026-09-24T01:05:00.000Z',
};

const httpError = (status: number, code: string) =>
  new ApiError('http', { status, code });

const notFound = () => httpError(404, 'receipt_not_found');

function fakeExpensesApi(overrides: Partial<DriverExpensesApi> = {}) {
  const api: DriverExpensesApi = {
    list: jest.fn(() => Promise.reject(new Error('not used'))),
    get: jest.fn(() => Promise.resolve(expense())),
    create: jest.fn(() => Promise.reject(new Error('not used'))),
    ...overrides,
  };
  return api;
}

function fakeReceiptsApi(overrides: Partial<DriverReceiptsApi> = {}) {
  const api: DriverReceiptsApi = {
    uploadIntent: jest.fn(() => Promise.resolve(POST_AUTH)),
    confirm: jest.fn(() => Promise.resolve(confirmed)),
    metadata: jest.fn<Promise<Receipt>, [string]>(() =>
      Promise.reject(notFound()),
    ),
    readAuthorization: jest.fn(() =>
      Promise.resolve({
        url: SIGNED_READ_URL,
        expiresAt: '2026-09-24T01:01:00.000Z',
      }),
    ),
    ...overrides,
  };
  return api;
}

/** A provider upload that succeeds without touching the network. */
function stubUploadFetch(ok = true) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = jest.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return { ok, status: ok ? 204 : 403 } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

async function renderDetail(
  expensesApi: DriverExpensesApi = fakeExpensesApi(),
  receiptsApi: DriverReceiptsApi = fakeReceiptsApi(),
  onBack = jest.fn(),
) {
  await render(
    <ExpenseDetailView
      expenseId={EXPENSE_ID}
      expensesApi={expensesApi}
      onBack={onBack}
      receiptsApi={receiptsApi}
    />,
  );
  return onBack;
}

const renderedText = (): string => JSON.stringify(screen.toJSON());

beforeEach(() => {
  picker.reset();
  picker.resolveFile({
    uri: PICKED_URI,
    contentType: 'image/jpeg',
    byteSize: 2048,
  });
  stubUploadFetch();
});

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('ExpenseDetailView expense fields', () => {
  it('shows every server-authoritative field', async () => {
    await renderDetail(
      fakeExpensesApi({
        get: () =>
          Promise.resolve(
            expense('REJECTED', {
              reviewNote: 'No receipt attached.',
              reviewedAt: '2026-09-25T02:00:00.000Z',
            }),
          ),
      }),
    );

    expect(await screen.findByText('₱1,250.00')).toBeOnTheScreen();
    expect(screen.getByText('Status: REJECTED')).toBeOnTheScreen();
    expect(screen.getByText('Category: FUEL')).toBeOnTheScreen();
    expect(
      screen.getByText('Incurred: 2026-09-24 08:30 Asia/Manila'),
    ).toBeOnTheScreen();
    expect(
      screen.getByText('Description: Synthetic fuel stop'),
    ).toBeOnTheScreen();
    expect(
      screen.getByText('Reviewed at: 2026-09-25 10:00 Asia/Manila'),
    ).toBeOnTheScreen();
    // The only feedback a rejection carries.
    expect(
      screen.getByText('Review note: No receipt attached.'),
    ).toBeOnTheScreen();
  });

  it('shows a placeholder where the server has nothing yet', async () => {
    await renderDetail();
    await screen.findByText('₱1,250.00');
    expect(screen.getByText('Reviewed at: —')).toBeOnTheScreen();
    expect(screen.getByText('Review note: —')).toBeOnTheScreen();
  });

  it('treats an unreachable expense as absent, not forbidden', async () => {
    await renderDetail(
      fakeExpensesApi({
        get: () => Promise.reject(httpError(404, 'expense_not_found')),
      }),
    );
    expect(await screen.findByText('Expense not found')).toBeOnTheScreen();
    expect(renderedText()).not.toMatch(/forbidden|another driver|403/i);
  });

  it('offers a retry on a load failure and returns to the trip', async () => {
    const get = jest
      .fn<Promise<Expense>, unknown[]>()
      .mockRejectedValueOnce(new ApiError('network'))
      .mockResolvedValueOnce(expense());
    await renderDetail(fakeExpensesApi({ get }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to reach the server. Try again.',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('₱1,250.00')).toBeOnTheScreen();
  });

  it('goes back to the trip', async () => {
    const onBack = await renderDetail();
    await screen.findByText('₱1,250.00');
    await fireEvent.press(screen.getByRole('button', { name: 'Back to trip' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('ExpenseDetailView receipt state matrix', () => {
  it('none + SUBMITTED offers an upload', async () => {
    await renderDetail();
    expect(await screen.findByText('No receipt attached.')).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Choose receipt' }),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'View receipt' })).toBeNull();
  });

  it.each(['APPROVED', 'REJECTED'] as const)(
    'none + %s offers no upload control',
    async (status) => {
      await renderDetail(
        fakeExpensesApi({ get: () => Promise.resolve(expense(status)) }),
      );
      await screen.findByText('No receipt attached.');
      // The API refuses a receipt mutation once the expense has been reviewed.
      expect(
        screen.queryByRole('button', { name: 'Choose receipt' }),
      ).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Confirm receipt' }),
      ).toBeNull();
    },
  );

  it('pending + SUBMITTED offers confirm and re-choose', async () => {
    await renderDetail(
      fakeExpensesApi(),
      fakeReceiptsApi({ metadata: jest.fn(() => Promise.resolve(pending)) }),
    );
    expect(
      await screen.findByText('Receipt uploaded but not yet confirmed.'),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Confirm receipt' }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Choose receipt again' }),
    ).toBeOnTheScreen();
  });

  it.each(['APPROVED', 'REJECTED'] as const)(
    'pending + %s offers no mutation control',
    async (status) => {
      await renderDetail(
        fakeExpensesApi({ get: () => Promise.resolve(expense(status)) }),
        fakeReceiptsApi({ metadata: jest.fn(() => Promise.resolve(pending)) }),
      );
      await screen.findByText('Receipt uploaded but not yet confirmed.');
      expect(
        screen.queryByRole('button', { name: 'Confirm receipt' }),
      ).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Choose receipt' }),
      ).toBeNull();
    },
  );

  it.each(['SUBMITTED', 'APPROVED', 'REJECTED'] as const)(
    'confirmed + %s is view-only',
    async (status) => {
      await renderDetail(
        fakeExpensesApi({ get: () => Promise.resolve(expense(status)) }),
        fakeReceiptsApi({
          metadata: jest.fn(() => Promise.resolve(confirmed)),
        }),
      );
      expect(
        await screen.findByText(
          'Receipt confirmed 2026-09-24 09:05 Asia/Manila.',
        ),
      ).toBeOnTheScreen();
      expect(
        screen.getByRole('button', { name: 'View receipt' }),
      ).toBeOnTheScreen();
      // Immutable: no delete, no replace, no confirm.
      expect(
        screen.queryByRole('button', { name: 'Choose receipt' }),
      ).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Confirm receipt' }),
      ).toBeNull();
      expect(
        screen.queryByRole('button', { name: /delete|replace/i }),
      ).toBeNull();
    },
  );

  it('keeps a failed metadata read distinct from "no receipt"', async () => {
    await renderDetail(
      fakeExpensesApi(),
      fakeReceiptsApi({
        metadata: jest.fn(() => Promise.reject(new ApiError('network'))),
      }),
    );
    await screen.findByText('₱1,250.00');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to reach the server. Try again.',
    );
    // A blip must not offer an upload the server might refuse.
    expect(screen.queryByText('No receipt attached.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose receipt' })).toBeNull();
  });
});

describe('ExpenseDetailView upload flow', () => {
  it('declares only the type and size, then confirms from the server', async () => {
    const receiptsApi = fakeReceiptsApi();
    await renderDetail(fakeExpensesApi(), receiptsApi);
    await screen.findByRole('button', { name: 'Choose receipt' });

    await fireEvent.press(
      screen.getByRole('button', { name: 'Choose receipt' }),
    );

    await waitFor(() => expect(receiptsApi.confirm).toHaveBeenCalled());
    expect(receiptsApi.uploadIntent).toHaveBeenCalledWith(EXPENSE_ID, {
      contentType: 'image/jpeg',
      byteSize: 2048,
    });
    expect(await screen.findByText('Receipt attached.')).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'View receipt' }),
    ).toBeOnTheScreen();
  });

  it('uploads to the provider, not to the Mansar API', async () => {
    const calls = stubUploadFetch();
    await renderDetail();
    await screen.findByRole('button', { name: 'Choose receipt' });
    await fireEvent.press(
      screen.getByRole('button', { name: 'Choose receipt' }),
    );

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url).toBe(POST_AUTH.url);
    // No Mansar credential reaches the provider.
    expect(JSON.stringify(calls[0]!.init.headers ?? {})).not.toMatch(
      /authorization|bearer/i,
    );
  });

  it('treats cancellation as an ordinary outcome', async () => {
    picker.resolveCancelled();
    const receiptsApi = fakeReceiptsApi();
    await renderDetail(fakeExpensesApi(), receiptsApi);
    await screen.findByRole('button', { name: 'Choose receipt' });

    await fireEvent.press(
      screen.getByRole('button', { name: 'Choose receipt' }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Choose receipt' }),
      ).toBeOnTheScreen(),
    );
    expect(receiptsApi.uploadIntent).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses an unsupported image locally, before any authorization', async () => {
    picker.resolveFile({
      uri: PICKED_URI,
      contentType: 'image/heic',
      byteSize: 2048,
    });
    const receiptsApi = fakeReceiptsApi();
    await renderDetail(fakeExpensesApi(), receiptsApi);
    await screen.findByRole('button', { name: 'Choose receipt' });

    await fireEvent.press(
      screen.getByRole('button', { name: 'Choose receipt' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Receipts must be a JPEG, PNG or WebP image. Choose another.',
    );
    expect(receiptsApi.uploadIntent).not.toHaveBeenCalled();
  });

  it('refuses an oversize image locally', async () => {
    picker.resolveFile({
      uri: PICKED_URI,
      contentType: 'image/jpeg',
      byteSize: 10 * 1024 * 1024 + 1,
    });
    const receiptsApi = fakeReceiptsApi();
    await renderDetail(fakeExpensesApi(), receiptsApi);
    await screen.findByRole('button', { name: 'Choose receipt' });
    await fireEvent.press(
      screen.getByRole('button', { name: 'Choose receipt' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That image is larger than 10 MB. Choose a smaller one.',
    );
    expect(receiptsApi.uploadIntent).not.toHaveBeenCalled();
  });

  it('sends exactly one upload however often the button is pressed', async () => {
    let settle!: (value: ReceiptUploadAuthorization) => void;
    const uploadIntent = jest.fn(
      () =>
        new Promise<ReceiptUploadAuthorization>((resolve) => {
          settle = resolve;
        }),
    );
    await renderDetail(fakeExpensesApi(), fakeReceiptsApi({ uploadIntent }));
    await screen.findByRole('button', { name: 'Choose receipt' });

    await fireEvent.press(
      screen.getByRole('button', { name: 'Choose receipt' }),
    );
    await waitFor(() => expect(uploadIntent).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByRole('button', { busy: true }));
    expect(uploadIntent).toHaveBeenCalledTimes(1);

    settle(POST_AUTH);
    await waitFor(() =>
      expect(screen.getByText('Receipt attached.')).toBeTruthy(),
    );
  });

  it('shows the pre-6G storage answer as a forward-looking sentence', async () => {
    await renderDetail(
      fakeExpensesApi(),
      fakeReceiptsApi({
        uploadIntent: jest.fn(() =>
          Promise.reject(httpError(503, 'receipt_storage_unavailable')),
        ),
      }),
    );
    await screen.findByRole('button', { name: 'Choose receipt' });
    await fireEvent.press(
      screen.getByRole('button', { name: 'Choose receipt' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Receipt upload is not available yet.',
    );
  });
});

describe('ExpenseDetailView reconciliation', () => {
  it('re-reads the receipt after a provider upload failure', async () => {
    stubUploadFetch(false);
    const metadata = jest
      .fn<Promise<Receipt>, [string]>()
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(pending);
    const receiptsApi = fakeReceiptsApi({ metadata });
    await renderDetail(fakeExpensesApi(), receiptsApi);
    await screen.findByRole('button', { name: 'Choose receipt' });

    await fireEvent.press(
      screen.getByRole('button', { name: 'Choose receipt' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The receipt could not be uploaded. Try again.',
    );
    // The pending row already exists server-side, so its state is re-read
    // rather than assumed, and confirm was never called.
    await waitFor(() => expect(metadata).toHaveBeenCalledTimes(2));
    expect(receiptsApi.confirm).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Receipt uploaded but not yet confirmed.'),
    ).toBeOnTheScreen();
  });

  it('never synthesises a confirmed receipt from the receiptId', async () => {
    stubUploadFetch(false);
    await renderDetail(
      fakeExpensesApi(),
      fakeReceiptsApi({
        metadata: jest
          .fn<Promise<Receipt>, [string]>()
          .mockRejectedValueOnce(notFound())
          .mockResolvedValueOnce(pending),
      }),
    );
    await screen.findByRole('button', { name: 'Choose receipt' });
    await fireEvent.press(
      screen.getByRole('button', { name: 'Choose receipt' }),
    );
    await screen.findByRole('alert');

    expect(screen.queryByText(/Receipt confirmed/)).toBeNull();
    expect(renderedText()).not.toContain(RECEIPT_ID);
  });

  it('reloads the expense when it has gone terminal underneath', async () => {
    const get = jest
      .fn<Promise<Expense>, unknown[]>()
      .mockResolvedValueOnce(expense('SUBMITTED'))
      .mockResolvedValueOnce(
        expense('APPROVED', { reviewedAt: '2026-09-25T02:00:00.000Z' }),
      );
    await renderDetail(
      fakeExpensesApi({ get }),
      fakeReceiptsApi({
        uploadIntent: jest.fn(() =>
          Promise.reject(httpError(409, 'expense_not_modifiable')),
        ),
      }),
    );
    await screen.findByRole('button', { name: 'Choose receipt' });
    await fireEvent.press(
      screen.getByRole('button', { name: 'Choose receipt' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This expense has been reviewed and its receipt can no longer be changed.',
    );
    // The screen now reflects the server's newer view, so the control is gone.
    expect(await screen.findByText('Status: APPROVED')).toBeOnTheScreen();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Choose receipt' }),
      ).toBeNull(),
    );
  });

  it('asks for a fresh upload on a mismatch rather than retrying the object', async () => {
    const receiptsApi = fakeReceiptsApi({
      metadata: jest.fn(() => Promise.resolve(pending)),
      confirm: jest.fn(() =>
        Promise.reject(httpError(409, 'receipt_upload_mismatch')),
      ),
    });
    await renderDetail(fakeExpensesApi(), receiptsApi);
    await screen.findByRole('button', { name: 'Confirm receipt' });

    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm receipt' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The uploaded image did not match what was expected. Choose the receipt again.',
    );
  });

  it('keeps a pending receipt retryable after an incomplete upload', async () => {
    const receiptsApi = fakeReceiptsApi({
      metadata: jest.fn(() => Promise.resolve(pending)),
      confirm: jest.fn(() =>
        Promise.reject(httpError(409, 'receipt_upload_incomplete')),
      ),
    });
    await renderDetail(fakeExpensesApi(), receiptsApi);
    await screen.findByRole('button', { name: 'Confirm receipt' });
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm receipt' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The receipt image did not finish uploading. Try uploading it again.',
    );
    expect(
      screen.getByRole('button', { name: 'Confirm receipt' }),
    ).toBeOnTheScreen();
  });

  it('converges on an already-confirmed receipt through the server answer', async () => {
    // Another confirmation won the race; the settled row comes back.
    const receiptsApi = fakeReceiptsApi({
      metadata: jest.fn(() => Promise.resolve(pending)),
      confirm: jest.fn(() => Promise.resolve(confirmed)),
    });
    await renderDetail(fakeExpensesApi(), receiptsApi);
    await screen.findByRole('button', { name: 'Confirm receipt' });
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm receipt' }),
    );

    expect(await screen.findByText('Receipt confirmed.')).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'View receipt' }),
    ).toBeOnTheScreen();
  });
});

describe('ExpenseDetailView receipt viewer', () => {
  async function openConfirmed(receiptsApi?: DriverReceiptsApi) {
    const api =
      receiptsApi ??
      fakeReceiptsApi({ metadata: jest.fn(() => Promise.resolve(confirmed)) });
    await renderDetail(fakeExpensesApi(), api);
    await screen.findByRole('button', { name: 'View receipt' });
    return api;
  }

  it('mints no read authorization until the driver taps View', async () => {
    const api = await openConfirmed();
    // Not on render: the URL is a short-lived bearer capability.
    expect(api.readAuthorization).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'View receipt' }));
    await waitFor(() => expect(api.readAuthorization).toHaveBeenCalledTimes(1));
    expect(api.readAuthorization).toHaveBeenCalledWith(EXPENSE_ID);
  });

  it('shows the image from the signed URL', async () => {
    await openConfirmed();
    await fireEvent.press(screen.getByRole('button', { name: 'View receipt' }));

    const image = await screen.findByLabelText('Receipt image');
    expect(image.props.source).toEqual({ uri: SIGNED_READ_URL });
    // No headers are needed: the authorization travels in the URL.
    expect(image.props.source.headers).toBeUndefined();
  });

  it('drops the signed URL when the viewer closes', async () => {
    await openConfirmed();
    await fireEvent.press(screen.getByRole('button', { name: 'View receipt' }));
    await screen.findByLabelText('Receipt image');

    await fireEvent.press(
      screen.getByRole('button', { name: 'Close receipt' }),
    );

    await waitFor(() =>
      expect(screen.queryByLabelText('Receipt image')).toBeNull(),
    );
    expect(renderedText()).not.toContain(SIGNED_READ_URL);
    expect(renderedText()).not.toContain('signature=synthetic-read');
  });

  it('mints a new authorization on each retry after an image failure', async () => {
    const api = await openConfirmed();
    await fireEvent.press(screen.getByRole('button', { name: 'View receipt' }));
    const image = await screen.findByLabelText('Receipt image');

    await fireEvent(image, 'error');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The receipt could not be shown. Try again.',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    // A stale signed URL is never retried; a fresh one is requested.
    await waitFor(() => expect(api.readAuthorization).toHaveBeenCalledTimes(2));
  });

  it('a stale success after Close does not reopen the modal', async () => {
    let settle!: (value: { url: string; expiresAt: string }) => void;
    const api = fakeReceiptsApi({
      metadata: jest.fn(() => Promise.resolve(confirmed)),
      readAuthorization: jest.fn(
        () =>
          new Promise<{ url: string; expiresAt: string }>((resolve) => {
            settle = resolve;
          }),
      ),
    });
    await openConfirmed(api);

    await fireEvent.press(screen.getByRole('button', { name: 'View receipt' }));
    await screen.findByLabelText('Opening receipt');

    // The driver gives up and closes while the request is still in flight.
    await fireEvent.press(
      screen.getByRole('button', { name: 'Close receipt' }),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText('Opening receipt')).toBeNull(),
    );

    // The authorization arrives afterwards; it is stale and must be dropped.
    settle({ url: SIGNED_READ_URL, expiresAt: '2026-09-24T01:01:00.000Z' });
    await waitFor(() =>
      expect(screen.queryByLabelText('Receipt image')).toBeNull(),
    );
    expect(renderedText()).not.toContain(SIGNED_READ_URL);
    expect(renderedText()).not.toContain('signature=synthetic-read');
    // The View control is back, not a reopened modal.
    expect(
      screen.getByRole('button', { name: 'View receipt' }),
    ).toBeOnTheScreen();
  });

  it('a stale failure after Close does not reopen the modal', async () => {
    let fail!: (reason: unknown) => void;
    const api = fakeReceiptsApi({
      metadata: jest.fn(() => Promise.resolve(confirmed)),
      readAuthorization: jest.fn(
        () =>
          new Promise<{ url: string; expiresAt: string }>(
            (_resolve, reject) => {
              fail = reject;
            },
          ),
      ),
    });
    await openConfirmed(api);

    await fireEvent.press(screen.getByRole('button', { name: 'View receipt' }));
    await screen.findByLabelText('Opening receipt');
    await fireEvent.press(
      screen.getByRole('button', { name: 'Close receipt' }),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText('Opening receipt')).toBeNull(),
    );

    fail(new ApiError('network'));
    // A closed viewer must not be reopened to show an error about a request
    // the driver already abandoned.
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Close receipt' }),
      ).toBeNull(),
    );
    expect(screen.queryByLabelText('Receipt image')).toBeNull();
    expect(
      screen.queryByText('Unable to open the receipt. Try again.'),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'View receipt' }),
    ).toBeOnTheScreen();
  });

  it('a later View still opens, after an abandoned earlier one', async () => {
    let first!: (value: { url: string; expiresAt: string }) => void;
    let call = 0;
    const api = fakeReceiptsApi({
      metadata: jest.fn(() => Promise.resolve(confirmed)),
      readAuthorization: jest.fn(() => {
        call += 1;
        if (call === 1) {
          return new Promise<{ url: string; expiresAt: string }>((resolve) => {
            first = resolve;
          });
        }
        return Promise.resolve({
          url: SIGNED_READ_URL,
          expiresAt: '2026-09-24T01:01:00.000Z',
        });
      }),
    });
    await openConfirmed(api);

    await fireEvent.press(screen.getByRole('button', { name: 'View receipt' }));
    await screen.findByLabelText('Opening receipt');
    await fireEvent.press(
      screen.getByRole('button', { name: 'Close receipt' }),
    );

    // A fresh press mints a new authorization, which is the active one.
    await fireEvent.press(screen.getByRole('button', { name: 'View receipt' }));
    expect(await screen.findByLabelText('Receipt image')).toBeOnTheScreen();

    // The abandoned first request resolving cannot disturb it.
    first({
      url: 'https://storage.example.test/stale?signature=stale',
      expiresAt: '2026-09-24T01:01:00.000Z',
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Receipt image').props.source).toEqual({
        uri: SIGNED_READ_URL,
      }),
    );
    expect(renderedText()).not.toContain('signature=stale');
  });

  it('reports a failed authorization safely', async () => {
    const api = fakeReceiptsApi({
      metadata: jest.fn(() => Promise.resolve(confirmed)),
      readAuthorization: jest.fn(() => Promise.reject(notFound())),
    });
    await openConfirmed(api);
    await fireEvent.press(screen.getByRole('button', { name: 'View receipt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No receipt has been attached to this expense.',
    );
  });
});

describe('ExpenseDetailView leaks nothing signed', () => {
  it('renders no signed field, policy, URL or object key at any point', async () => {
    const receiptsApi = fakeReceiptsApi();
    await renderDetail(fakeExpensesApi(), receiptsApi);
    await screen.findByRole('button', { name: 'Choose receipt' });
    await fireEvent.press(
      screen.getByRole('button', { name: 'Choose receipt' }),
    );
    await screen.findByText('Receipt attached.');

    const shown = renderedText();
    for (const secret of [
      'synthetic-policy',
      'synthetic/key.jpg',
      'storage.example.test',
      PICKED_URI,
      RECEIPT_ID,
      'x-amz',
    ]) {
      expect(shown).not.toContain(secret);
    }
  });

  it('shows no object key even when the metadata body carries one', async () => {
    await renderDetail(
      fakeExpensesApi(),
      fakeReceiptsApi({
        metadata: jest.fn(() =>
          Promise.resolve({
            ...confirmed,
            objectKey: 'receipts/synthetic/key.jpg',
          } as Receipt),
        ),
      }),
    );
    await screen.findByRole('button', { name: 'View receipt' });
    expect(renderedText()).not.toContain('receipts/synthetic');
  });
});
