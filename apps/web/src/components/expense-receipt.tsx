'use client';

import type { Expense, Receipt } from '@mansar/types';
import { type ChangeEvent, useCallback, useEffect, useState } from 'react';

import {
  adminErrorMessage,
  confirmExpenseReceipt,
  createReceiptReadAuthorization,
  createReceiptUploadIntent,
  getExpenseReceipt,
} from '@/lib/client/admin-api';
import { uploadReceiptBinary } from '@/lib/client/receipt-upload';
import { formatPhp } from '@/lib/money';
import { formatTripTime } from '@/lib/trip-time';

/** The three frozen receipt image types, as both the API and the store see them. */
export const RECEIPT_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const RECEIPT_MIN_BYTE_SIZE = 1;
export const RECEIPT_MAX_BYTE_SIZE = 10 * 1024 * 1024;

const UPLOAD_FAILED =
  'Receipt upload could not be completed. Please try again.';
const PREVIEW_FAILED =
  'Receipt preview could not be loaded. Choose View receipt to try again.';
const WRONG_TYPE = 'Choose a JPEG, PNG or WebP image.';
const WRONG_SIZE = 'Choose an image between 1 byte and 10 MiB.';

interface Props {
  readonly expense: Expense;
  /** The server proved our copy of the expense stale; parent should re-read. */
  readonly onExpenseStale: () => void;
}

/**
 * Human-readable bytes. Display only — unlike a peso amount this is not
 * business arithmetic, so ordinary number maths is fine here.
 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} byte${bytes === 1 ? '' : 's'}`;
  }
  const kib = bytes / 1024;
  return kib < 1024
    ? `${kib.toFixed(1)} KiB`
    : `${(kib / 1024).toFixed(1)} MiB`;
}

type MetadataState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'none' }
  | { readonly kind: 'ready'; readonly receipt: Receipt }
  | { readonly kind: 'error'; readonly message: string };

/**
 * The receipt attached to one expense: its metadata, its upload, and a
 * short-lived preview of the stored image.
 *
 * Three metadata states exist and only three — none, pending and confirmed.
 * Storage being unavailable is deliberately *not* a fourth: it is a
 * transient failure of an action layered over whichever state the receipt
 * is actually in, so a 503 leaves the metadata, the expense summary and the
 * review controls exactly as they were rather than blanking the section.
 *
 * The binary never passes through this application's servers. The API
 * authorizes an upload, the browser sends the bytes straight to the store,
 * and the API afterwards verifies that they arrived — so the only thing
 * that makes a receipt real is the confirmation response, never the
 * provider's answer.
 */
export function ExpenseReceipt({ expense, onExpenseStale }: Props) {
  const [state, setState] = useState<MetadataState>({ kind: 'loading' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const expenseId = expense.id;

  /** Always re-reads from the API; never synthesises metadata locally. */
  const reload = useCallback(async (): Promise<void> => {
    const result = await getExpenseReceipt(expenseId);
    if (result.ok) {
      setState({ kind: 'ready', receipt: result.data });
      return;
    }
    if (result.status === 404) {
      // Normal state, not a failure: no receipt, or a pending one on an
      // expense that has since been reviewed.
      setState({ kind: 'none' });
      return;
    }
    setState({ kind: 'error', message: adminErrorMessage(result) });
  }, [expenseId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getExpenseReceipt(expenseId);
      if (cancelled) {
        return;
      }
      if (result.ok) {
        setState({ kind: 'ready', receipt: result.data });
      } else if (result.status === 404) {
        setState({ kind: 'none' });
      } else {
        setState({ kind: 'error', message: adminErrorMessage(result) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expenseId]);

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    setError(null);
    setOutcome(null);
    if (chosen === null) {
      setFile(null);
      return;
    }
    // `File.type`, never the filename: an extension is a claim the user
    // controls, and the signed policy binds the declared type exactly.
    if (!RECEIPT_CONTENT_TYPES.includes(chosen.type as never)) {
      setFile(null);
      setError(WRONG_TYPE);
      return;
    }
    if (
      chosen.size < RECEIPT_MIN_BYTE_SIZE ||
      chosen.size > RECEIPT_MAX_BYTE_SIZE
    ) {
      setFile(null);
      setError(WRONG_SIZE);
      return;
    }
    setFile(chosen);
  };

  /** Intent, direct upload, confirm — in that order, and no other. */
  const upload = async (): Promise<void> => {
    if (file === null) {
      return;
    }
    setBusy(true);
    setError(null);
    setOutcome(null);

    const intent = await createReceiptUploadIntent(expenseId, {
      contentType: file.type,
      byteSize: file.size,
    });
    if (!intent.ok) {
      setError(adminErrorMessage(intent));
      // The API writes the pending row *before* it signs, so a failed
      // intent may still have changed the stored declaration. Re-read
      // rather than assuming nothing happened.
      await reload();
      if (intent.code === 'expense_not_modifiable') {
        onExpenseStale();
      }
      setBusy(false);
      return;
    }

    try {
      await uploadReceiptBinary(intent.data, file);
    } catch {
      // One fixed message: the provider's own error text never reaches an
      // admin. Confirmation is deliberately not attempted.
      setError(UPLOAD_FAILED);
      await reload();
      setBusy(false);
      return;
    }

    await runConfirm();
    setBusy(false);
  };

  /**
   * Standalone confirmation, which is why it is separate from `upload`.
   * When the bytes reached the store but the confirm request failed, the
   * object is already there — re-uploading it would be pure waste.
   */
  const runConfirm = async (): Promise<void> => {
    const confirmed = await confirmExpenseReceipt(expenseId);
    if (!confirmed.ok) {
      setError(adminErrorMessage(confirmed));
      await reload();
      if (confirmed.code === 'expense_not_modifiable') {
        // Reviewed while the upload was in flight.
        onExpenseStale();
      }
      return;
    }
    setState({ kind: 'ready', receipt: confirmed.data });
    setFile(null);
    setPreviewUrl(null);
    setOutcome('Receipt confirmed.');
  };

  const confirmOnly = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    await runConfirm();
    setBusy(false);
  };

  /** Mints a short-lived signed URL, held in component state and nowhere else. */
  const view = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await createReceiptReadAuthorization(expenseId);
    setBusy(false);
    if (!result.ok) {
      setError(adminErrorMessage(result));
      return;
    }
    setPreviewUrl(result.data.url);
  };

  const receipt = state.kind === 'ready' ? state.receipt : null;
  const confirmed = receipt !== null && receipt.confirmedAt !== null;
  const pending = receipt !== null && receipt.confirmedAt === null;
  // A terminal expense can begin no receipt mutation at all, so the picker
  // is not offered rather than offered and refused.
  const mutable = expense.status === 'SUBMITTED';

  return (
    <section aria-labelledby="expense-receipt-heading">
      <h2 id="expense-receipt-heading">Receipt</h2>

      {state.kind === 'loading' ? <p role="status">Loading receipt…</p> : null}
      {state.kind === 'error' ? <p role="alert">{state.message}</p> : null}

      {state.kind === 'none' ? <p>No receipt attached.</p> : null}

      {receipt !== null ? (
        <dl>
          <dt>State</dt>
          <dd>{confirmed ? 'Confirmed' : 'Upload not confirmed.'}</dd>
          <dt>Content type</dt>
          <dd>{receipt.contentType}</dd>
          <dt>Size</dt>
          <dd>{formatByteSize(receipt.byteSize)}</dd>
          <dt>Created</dt>
          <dd>{formatTripTime(receipt.createdAt)}</dd>
          {confirmed ? (
            <>
              <dt>Confirmed at</dt>
              <dd>{formatTripTime(receipt.confirmedAt)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {/* Upload controls: only while the expense itself is still open, and
          never for a confirmed receipt, which is immutable. */}
      {mutable && !confirmed && state.kind !== 'loading' ? (
        <div>
          <p>
            <label htmlFor="expense-receipt-file">
              {pending ? 'Choose a different image' : 'Receipt image'}
            </label>
            <br />
            <input
              id="expense-receipt-file"
              name="receipt"
              type="file"
              accept={RECEIPT_CONTENT_TYPES.join(',')}
              disabled={busy}
              onChange={choose}
            />
          </p>
          <p>
            <button
              type="button"
              onClick={() => void upload()}
              disabled={busy || file === null}
              aria-busy={busy}
            >
              Upload receipt
            </button>{' '}
            {pending ? (
              <button
                type="button"
                onClick={() => void confirmOnly()}
                disabled={busy}
                aria-busy={busy}
              >
                Confirm upload
              </button>
            ) : null}
          </p>
        </div>
      ) : null}

      {confirmed ? (
        <p>
          <button
            type="button"
            onClick={() => void view()}
            disabled={busy}
            aria-busy={busy}
          >
            View receipt
          </button>
        </p>
      ) : null}

      {previewUrl !== null ? (
        // The signed URL lives only here, as an image source, for the
        // seconds it stays valid. It is never stored, logged or routed.
        <p>
          {/*
            A plain <img>, not next/image, and deliberately so. next/image
            proxies through the Next server's optimizer, which would route
            the receipt binary through this application — the one thing the
            direct-upload architecture exists to prevent — and would need
            the storage host allow-listed in remotePatterns, which is not
            known until the bucket exists. A cross-origin <img> also needs
            no CORS entitlement, unlike fetching the bytes ourselves.
          */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt={`Receipt for the ${expense.category} expense of ${formatPhp(
              expense.amount,
            )} incurred on ${formatTripTime(expense.incurredAt)}`}
            onError={() => {
              setPreviewUrl(null);
              setError(PREVIEW_FAILED);
            }}
          />
        </p>
      ) : null}

      {error ? <p role="alert">{error}</p> : null}
      {outcome ? <p role="status">{outcome}</p> : null}
    </section>
  );
}
