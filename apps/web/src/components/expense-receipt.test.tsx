import type { Expense, ExpenseStatus } from '@mansar/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { ExpenseReceipt, formatByteSize } from './expense-receipt';

/**
 * Zero real object storage. The only non-BFF origin in this file is the
 * synthetic `.test` host; no credential, bucket or provider domain appears.
 */
const STORAGE_ORIGIN = 'https://storage.example.test';
const EXPENSE_ID = '019a0000-0000-7000-8000-000000000002';
const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const RECEIPT_ID = '019a0000-0000-7000-8000-000000000003';

const expense = (status: ExpenseStatus = 'SUBMITTED'): Expense => ({
  id: EXPENSE_ID,
  tripId: TRIP_ID,
  status,
  amount: '1250.00',
  category: 'FUEL',
  incurredAt: '2026-09-24T00:30:00.000Z',
  description: '',
  reviewNote: '',
  reviewedAt: status === 'SUBMITTED' ? null : '2026-09-25T00:00:00.000Z',
  createdAt: '2026-09-24T01:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z',
});

const PENDING = {
  id: RECEIPT_ID,
  expenseId: EXPENSE_ID,
  contentType: 'image/jpeg',
  byteSize: 2048,
  confirmedAt: null,
  createdAt: '2026-09-24T02:00:00.000Z',
};
const CONFIRMED = { ...PENDING, confirmedAt: '2026-09-24T03:00:00.000Z' };

const UPLOAD_AUTH = {
  receiptId: RECEIPT_ID,
  method: 'POST',
  url: `${STORAGE_ORIGIN}/upload`,
  fields: { key: 'receipts/a/b', policy: 'synthetic-policy' },
  expiresAt: '2026-09-24T02:05:00.000Z',
};
const READ_AUTH = {
  url: `${STORAGE_ORIGIN}/read/synthetic?signature=synthetic`,
  expiresAt: '2026-09-24T03:01:00.000Z',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

interface Call {
  readonly url: string;
  readonly method: string;
}

/** Routes by URL; anything unmatched is a hard failure, not a silent 200. */
function installFetch(
  routes: (url: string, method: string, seen: number) => Response,
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const seen = calls.filter((c) => c.url === url).length;
      calls.push({ url, method });
      return routes(url, method, seen);
    }),
  );
  return calls;
}

const RECEIPT_PATH = `/api/backend/expenses/${EXPENSE_ID}/receipt`;

const file = (type = 'image/jpeg', size = 2048) => {
  const made = new File([new Uint8Array(1)], 'receipt.jpg', { type });
  Object.defineProperty(made, 'size', { value: size });
  return made;
};

const choose = (chosen: File) =>
  fireEvent.change(screen.getByLabelText(/Receipt image|different image/), {
    target: { files: [chosen] },
  });

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

describe('formatByteSize', () => {
  it.each([
    [0, '0 bytes'],
    [1, '1 byte'],
    [512, '512 bytes'],
    [1023, '1023 bytes'],
    [1024, '1.0 KiB'],
    [2048, '2.0 KiB'],
    [1536, '1.5 KiB'],
    [1048576, '1.0 MiB'],
    [10485760, '10.0 MiB'],
  ])('renders %d as %s', (bytes, expected) => {
    expect(formatByteSize(bytes)).toBe(expected);
  });
});

describe('ExpenseReceipt — no receipt', () => {
  it('says so and offers upload while the expense is SUBMITTED', async () => {
    installFetch(() => json(404, { message: 'receipt_not_found' }));
    render(
      <ExpenseReceipt
        expense={expense('SUBMITTED')}
        onExpenseStale={vi.fn()}
      />,
    );

    expect(await screen.findByText('No receipt attached.')).toBeInTheDocument();
    expect(screen.getByLabelText('Receipt image')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Upload receipt' }),
    ).toBeInTheDocument();
    // A missing receipt is a normal state, not a failure.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['APPROVED', 'REJECTED'] as const)(
    'offers no upload at all once the expense is %s',
    async (status) => {
      installFetch(() => json(404, { message: 'receipt_not_found' }));
      render(
        <ExpenseReceipt expense={expense(status)} onExpenseStale={vi.fn()} />,
      );

      expect(
        await screen.findByText('No receipt attached.'),
      ).toBeInTheDocument();
      // A terminal expense can begin no receipt mutation, so the controls
      // are absent rather than present and doomed.
      expect(screen.queryByLabelText('Receipt image')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Upload receipt' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /replace/i }),
      ).not.toBeInTheDocument();
    },
  );
});

describe('ExpenseReceipt — pending', () => {
  it('shows the declaration and both recovery actions', async () => {
    installFetch(() => json(200, PENDING));
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);

    expect(
      await screen.findByText('Upload not confirmed.'),
    ).toBeInTheDocument();
    expect(screen.getByText('image/jpeg')).toBeInTheDocument();
    expect(screen.getByText('2.0 KiB')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Choose a different image'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Upload receipt' }),
    ).toBeInTheDocument();
    // Recovers when the bytes landed but the confirm request did not.
    expect(
      screen.getByRole('button', { name: 'Confirm upload' }),
    ).toBeInTheDocument();
  });

  it('confirms an already-uploaded object without re-uploading', async () => {
    const calls = installFetch((url) =>
      url.endsWith('/confirm') ? json(200, CONFIRMED) : json(200, PENDING),
    );
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('Upload not confirmed.');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm upload' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Receipt confirmed.',
    );
    expect(calls.some((c) => c.url.includes('upload-intent'))).toBe(false);
    expect(calls.some((c) => c.url.startsWith(STORAGE_ORIGIN))).toBe(false);
  });
});

describe('ExpenseReceipt — confirmed', () => {
  it('shows the metadata and only a view action', async () => {
    installFetch(() => json(200, CONFIRMED));
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);

    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
    expect(
      screen.getByText('2026-09-24 11:00 Asia/Manila'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'View receipt' }),
    ).toBeInTheDocument();
  });

  it('never offers replace, upload or delete for an immutable receipt', async () => {
    installFetch(() => json(200, CONFIRMED));
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('Confirmed');

    expect(
      screen.queryByRole('button', { name: 'Upload receipt' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /replace/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /delete/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/image/i)).not.toBeInTheDocument();
  });
});

describe('ExpenseReceipt — local file validation', () => {
  it.each([
    ['a PDF', 'application/pdf'],
    ['a GIF', 'image/gif'],
    ['an empty type', ''],
  ])('refuses %s before any request', async (_label, type) => {
    const calls = installFetch(() =>
      json(404, { message: 'receipt_not_found' }),
    );
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('No receipt attached.');
    const before = calls.length;

    choose(file(type));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose a JPEG, PNG or WebP image.',
    );
    expect(calls).toHaveLength(before);
    expect(
      screen.getByRole('button', { name: 'Upload receipt' }),
    ).toBeDisabled();
  });

  it.each([
    ['an empty file', 0],
    ['one byte over 10 MiB', 10 * 1024 * 1024 + 1],
  ])('refuses %s before any request', async (_label, size) => {
    const calls = installFetch(() =>
      json(404, { message: 'receipt_not_found' }),
    );
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('No receipt attached.');
    const before = calls.length;

    choose(file('image/jpeg', size));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose an image between 1 byte and 10 MiB.',
    );
    expect(calls).toHaveLength(before);
  });
});

describe('ExpenseReceipt — upload flow', () => {
  it('declares exactly File.type and File.size, then uploads and confirms', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/upload-intent')) {
          bodies.push(JSON.parse(init!.body as string));
          return json(200, UPLOAD_AUTH);
        }
        if (url.startsWith(STORAGE_ORIGIN)) {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith('/confirm')) {
          return json(200, CONFIRMED);
        }
        return json(404, { message: 'receipt_not_found' });
      }),
    );
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('No receipt attached.');

    choose(file('image/png', 4096));
    fireEvent.click(screen.getByRole('button', { name: 'Upload receipt' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Receipt confirmed.',
    );
    expect(bodies).toEqual([{ contentType: 'image/png', byteSize: 4096 }]);
  });

  it('sends the binary straight to the provider, never through the BFF', async () => {
    const calls = installFetch((url) => {
      if (url.endsWith('/upload-intent')) return json(200, UPLOAD_AUTH);
      if (url.startsWith(STORAGE_ORIGIN))
        return new Response(null, { status: 204 });
      if (url.endsWith('/confirm')) return json(200, CONFIRMED);
      return json(404, { message: 'receipt_not_found' });
    });
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('No receipt attached.');

    choose(file());
    fireEvent.click(screen.getByRole('button', { name: 'Upload receipt' }));
    await screen.findByRole('status');

    const providerCalls = calls.filter((c) => c.url.startsWith(STORAGE_ORIGIN));
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]!.url).toBe(`${STORAGE_ORIGIN}/upload`);
    // The bytes never touch a Mansar origin.
    expect(
      calls.some((c) => c.url.includes('/api/backend') && c.method === 'PUT'),
    ).toBe(false);
  });

  it('does not confirm when the provider upload fails, and re-reads metadata', async () => {
    const calls = installFetch((url) => {
      if (url.endsWith('/upload-intent')) return json(200, UPLOAD_AUTH);
      if (url.startsWith(STORAGE_ORIGIN))
        return new Response('<Error>AccessDenied</Error>', { status: 403 });
      if (url.endsWith('/confirm')) return json(200, CONFIRMED);
      return json(200, PENDING);
    });
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('Upload not confirmed.');

    choose(file());
    fireEvent.click(screen.getByRole('button', { name: 'Upload receipt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Receipt upload could not be completed. Please try again.',
    );
    expect(calls.some((c) => c.url.endsWith('/confirm'))).toBe(false);
    // Reconciled against the server rather than assumed.
    expect(calls.filter((c) => c.url === RECEIPT_PATH).length).toBeGreaterThan(
      1,
    );
    // The provider's own words never reach the page.
    expect(document.body.innerHTML).not.toContain('AccessDenied');
  });

  it('re-reads metadata when upload-intent fails, because the row may already exist', async () => {
    const calls = installFetch((url) => {
      if (url.endsWith('/upload-intent'))
        return json(503, { message: 'receipt_storage_unavailable' });
      return json(200, PENDING);
    });
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('Upload not confirmed.');

    choose(file());
    fireEvent.click(screen.getByRole('button', { name: 'Upload receipt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Receipt storage is not available right now.',
    );
    // The API writes the pending row before it signs, so "intent failed"
    // does not mean "nothing changed".
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url === RECEIPT_PATH).length,
      ).toBeGreaterThan(1),
    );
  });

  it('asks the parent to re-read the expense when the server says it is terminal', async () => {
    installFetch((url) => {
      if (url.endsWith('/upload-intent'))
        return json(409, { message: 'expense_not_modifiable' });
      return json(200, PENDING);
    });
    const onExpenseStale = vi.fn();
    render(
      <ExpenseReceipt expense={expense()} onExpenseStale={onExpenseStale} />,
    );
    await screen.findByText('Upload not confirmed.');

    choose(file());
    fireEvent.click(screen.getByRole('button', { name: 'Upload receipt' }));

    await waitFor(() => expect(onExpenseStale).toHaveBeenCalled());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This expense can no longer accept receipt changes.',
    );
  });

  it('reports a confirm mismatch safely and re-reads metadata', async () => {
    const calls = installFetch((url) => {
      if (url.endsWith('/upload-intent')) return json(200, UPLOAD_AUTH);
      if (url.startsWith(STORAGE_ORIGIN))
        return new Response(null, { status: 204 });
      if (url.endsWith('/confirm'))
        return json(409, { message: 'receipt_upload_mismatch' });
      return json(200, PENDING);
    });
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('Upload not confirmed.');

    choose(file());
    fireEvent.click(screen.getByRole('button', { name: 'Upload receipt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The uploaded file does not match the receipt details.',
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url === RECEIPT_PATH).length,
      ).toBeGreaterThan(1),
    );
  });

  it('re-reads metadata when another tab already confirmed', async () => {
    const calls = installFetch((url) => {
      if (url.endsWith('/confirm'))
        return json(409, { message: 'receipt_not_modifiable' });
      return json(200, PENDING);
    });
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('Upload not confirmed.');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm upload' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This receipt has already been confirmed and cannot be replaced.',
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url === RECEIPT_PATH).length,
      ).toBeGreaterThan(1),
    );
  });
});

describe('ExpenseReceipt — viewing', () => {
  it('mints a signed URL only when asked, and uses it as the image source', async () => {
    const calls = installFetch((url) =>
      url.endsWith('/read-authorization')
        ? json(200, READ_AUTH)
        : json(200, CONFIRMED),
    );
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('Confirmed');

    // Nothing signed is requested until the admin asks for it.
    expect(calls.some((c) => c.url.endsWith('/read-authorization'))).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View receipt' }));

    const image = await screen.findByRole('img');
    expect(image).toHaveAttribute('src', READ_AUTH.url);
  });

  it('describes the expense in the alt text without claiming to describe the image', async () => {
    installFetch((url) =>
      url.endsWith('/read-authorization')
        ? json(200, READ_AUTH)
        : json(200, CONFIRMED),
    );
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('Confirmed');
    fireEvent.click(screen.getByRole('button', { name: 'View receipt' }));

    expect(await screen.findByRole('img')).toHaveAttribute(
      'alt',
      'Receipt for the FUEL expense of ₱1,250.00 incurred on 2026-09-24 08:30 Asia/Manila',
    );
  });

  it('never persists the signed URL anywhere', async () => {
    installFetch((url) =>
      url.endsWith('/read-authorization')
        ? json(200, READ_AUTH)
        : json(200, CONFIRMED),
    );
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('Confirmed');
    fireEvent.click(screen.getByRole('button', { name: 'View receipt' }));
    await screen.findByRole('img');

    // Transient component state and an img src only.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.search).toBe('');
  });

  it('offers a retry when the preview will not load', async () => {
    installFetch((url) =>
      url.endsWith('/read-authorization')
        ? json(200, READ_AUTH)
        : json(200, CONFIRMED),
    );
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('Confirmed');
    fireEvent.click(screen.getByRole('button', { name: 'View receipt' }));

    fireEvent.error(await screen.findByRole('img'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Receipt preview could not be loaded. Choose View receipt to try again.',
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    // A fresh capability can be minted on another click.
    expect(screen.getByRole('button', { name: 'View receipt' })).toBeEnabled();
  });

  it('keeps the confirmed receipt visible when storage is unavailable', async () => {
    installFetch((url) =>
      url.endsWith('/read-authorization')
        ? json(503, { message: 'receipt_storage_unavailable' })
        : json(200, CONFIRMED),
    );
    render(<ExpenseReceipt expense={expense()} onExpenseStale={vi.fn()} />);
    await screen.findByText('Confirmed');
    fireEvent.click(screen.getByRole('button', { name: 'View receipt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Receipt storage is not available right now.',
    );
    // Storage being down is a failed action, not a lost receipt.
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('image/jpeg')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
