import type { Expense, Receipt } from '@mansar/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  pickReceiptFile,
  receiptPickMessage,
  ReceiptPickError,
} from '../receipts/receipt-picker';
import { uploadReceiptBinary } from '../receipts/receipt-upload';
import type { DriverReceiptsApi } from '../receipts/driver-receipts-api';
import { formatTripTime, NO_TIME } from '../trips/trip-time';
import type { DriverExpensesApi } from './driver-expenses-api';
import {
  driverExpenseMessage,
  EXPENSE_FALLBACK,
  isExpenseNotFound,
  isReceiptNotFound,
  requiresFreshUpload,
} from './driver-expense-messages';
import { formatPhp } from './money';

interface Props {
  readonly expenseId: string;
  readonly expensesApi: DriverExpensesApi;
  readonly receiptsApi: DriverReceiptsApi;
  readonly onBack: () => void;
}

type ExpenseState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly expense: Expense }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * The receipt's durable state, as the server reports it.
 *
 * Exactly three, matching the backend: absent, uploaded-but-unverified, and
 * verified. Loading and failure are request states held separately — a failed
 * read does not mean there is no receipt, and treating it as a fourth state
 * would let a network blip offer an upload that the server would refuse.
 */
type ReceiptState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'none' }
  | { readonly kind: 'pending'; readonly receipt: Receipt }
  | { readonly kind: 'confirmed'; readonly receipt: Receipt }
  | { readonly kind: 'error'; readonly message: string };

/** The signed read URL lives here and nowhere else, for as long as it is shown. */
type ViewerState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'open'; readonly url: string }
  | { readonly kind: 'error'; readonly message: string };

function receiptStateOf(receipt: Receipt): ReceiptState {
  return receipt.confirmedAt === null
    ? { kind: 'pending', receipt }
    : { kind: 'confirmed', receipt };
}

/**
 * One of the driver's own expenses, with its receipt.
 *
 * Everything shown is the server's answer. The review note matters most here:
 * it is the only place a driver learns *why* an expense was rejected, so it is
 * displayed whenever the server has set one.
 *
 * The receipt flow is pick → authorize → upload → confirm, and every step is
 * reconciled against the server rather than assumed. A `receiptId` is never
 * turned into a confirmed receipt locally: only `confirm` — or a fresh read of
 * the metadata — may say a receipt is settled. There is no delete and no
 * replace, because the API has neither.
 *
 * The signed upload authorization and the signed read URL are held in local
 * state for the one operation that needs them and are never logged, persisted
 * or passed upward.
 */
export function ExpenseDetailView({
  expenseId,
  expensesApi,
  receiptsApi,
  onBack,
}: Props) {
  const [state, setState] = useState<ExpenseState>({ kind: 'loading' });
  const [receipt, setReceipt] = useState<ReceiptState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerState>({ kind: 'closed' });

  // Signing out unmounts this screen while a request may still be in flight;
  // its continuation must not then touch state.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await expensesApi.get(expenseId);
        if (!cancelled) {
          setState({ kind: 'ready', expense: loaded });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setState(
          isExpenseNotFound(error)
            ? { kind: 'missing' }
            : {
                kind: 'error',
                message: driverExpenseMessage(error, EXPENSE_FALLBACK.detail),
              },
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expensesApi, expenseId, attempt]);

  /**
   * Asks the server what the receipt's state is; 404 means there is none.
   *
   * Returns the state rather than setting it, so the caller decides whether
   * it is still wanted — the mount effect drops a superseded answer, and the
   * reconciliation paths apply it only while mounted.
   */
  const resolveReceipt = useCallback(async (): Promise<ReceiptState> => {
    try {
      return receiptStateOf(await receiptsApi.metadata(expenseId));
    } catch (error) {
      return isReceiptNotFound(error)
        ? { kind: 'none' }
        : {
            kind: 'error',
            message: driverExpenseMessage(error, EXPENSE_FALLBACK.receipt),
          };
    }
  }, [receiptsApi, expenseId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await resolveReceipt();
      if (!cancelled) {
        setReceipt(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resolveReceipt, attempt]);

  /** Applies the server's current receipt state, if this screen still exists. */
  const readReceipt = async (): Promise<void> => {
    const next = await resolveReceipt();
    if (mounted.current) {
      setReceipt(next);
    }
  };

  /** Re-reads the expense as well, for a state that may have moved on. */
  const reload = () => {
    setState({ kind: 'loading' });
    setReceipt({ kind: 'loading' });
    setAttempt((previous) => previous + 1);
  };

  const expense = state.kind === 'ready' ? state.expense : null;
  const open = expense?.status === 'SUBMITTED';

  /**
   * Attach a receipt: choose, authorize, upload, confirm.
   *
   * Each failure is reconciled by re-reading the server rather than guessing.
   * The pending row may already exist after a failed upload, so the metadata
   * is re-read even when the upload never completed.
   */
  const attach = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setActionError(null);
    setOutcome(null);
    try {
      const file = await pickReceiptFile();
      if (file === null) {
        // Cancellation is an ordinary outcome, not an error.
        setBusy(false);
        return;
      }
      const authorization = await receiptsApi.uploadIntent(expenseId, {
        contentType: file.contentType,
        byteSize: file.byteSize,
      });
      await uploadReceiptBinary(authorization, file);
      // Only the server may say a receipt is confirmed.
      const confirmed = await receiptsApi.confirm(expenseId);
      if (!mounted.current) {
        return;
      }
      setReceipt(receiptStateOf(confirmed));
      setOutcome('Receipt attached.');
    } catch (error) {
      if (!mounted.current) {
        return;
      }
      if (error instanceof ReceiptPickError) {
        // Nothing was sent, so nothing needs reconciling.
        setActionError(receiptPickMessage(error));
      } else {
        setActionError(driverExpenseMessage(error, EXPENSE_FALLBACK.upload));
        // The server's view may have moved on, or a pending row may now
        // exist; either way its answer replaces whatever we assumed.
        await readReceipt();
        if (requiresFreshUpload(error)) {
          setActionError(driverExpenseMessage(error, EXPENSE_FALLBACK.upload));
        }
        await refreshExpenseQuietly();
      }
    }
    if (mounted.current) {
      setBusy(false);
    }
  };

  /** Re-reads the expense without disturbing what is on screen on failure. */
  const refreshExpenseQuietly = async (): Promise<void> => {
    try {
      const fresh = await expensesApi.get(expenseId);
      if (mounted.current) {
        setState({ kind: 'ready', expense: fresh });
      }
    } catch {
      // The receipt message already explains what happened; the last
      // authoritative expense is kept exactly as it was.
    }
  };

  /** Confirms an already-uploaded object, without re-uploading it. */
  const confirmPending = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setActionError(null);
    setOutcome(null);
    try {
      const confirmed = await receiptsApi.confirm(expenseId);
      if (mounted.current) {
        setReceipt(receiptStateOf(confirmed));
        setOutcome('Receipt confirmed.');
      }
    } catch (error) {
      if (mounted.current) {
        setActionError(driverExpenseMessage(error, EXPENSE_FALLBACK.confirm));
        await readReceipt();
        await refreshExpenseQuietly();
      }
    }
    if (mounted.current) {
      setBusy(false);
    }
  };

  /**
   * Mints a read authorization, on this press only.
   *
   * Never on render: the authorization is short-lived and is a bearer
   * capability for the image, so it is created when the driver asks to look
   * and discarded when they stop looking.
   *
   * Each press claims a generation. Closing the viewer — or pressing View
   * again — advances the counter, so a request that resolves afterwards finds
   * its own generation stale and drops its result. Without that, closing while
   * a request was still in flight would let the response reopen the modal a
   * moment later, putting a signed URL back on screen after the driver had
   * dismissed it. A rejection is dropped for the same reason: a closed viewer
   * must not be reopened to show an error about a request the driver abandoned.
   *
   * A counter rather than an AbortController: the request itself is cheap and
   * already short-lived, and what matters is that its *result* cannot be
   * adopted, which no cancellation API is needed to guarantee.
   */
  const viewerGeneration = useRef(0);

  const viewReceipt = async () => {
    const generation = viewerGeneration.current + 1;
    viewerGeneration.current = generation;
    setViewer({ kind: 'loading' });

    const current = () =>
      mounted.current && viewerGeneration.current === generation;
    try {
      const authorization = await receiptsApi.readAuthorization(expenseId);
      if (current()) {
        setViewer({ kind: 'open', url: authorization.url });
      }
      // Otherwise the signed URL simply goes out of scope unused: it is never
      // stored, logged or handed anywhere else.
    } catch (error) {
      if (current()) {
        setViewer({
          kind: 'error',
          message: driverExpenseMessage(error, EXPENSE_FALLBACK.view),
        });
      }
    }
  };

  /**
   * Closing drops the signed URL and invalidates any request still in flight,
   * so nothing keeps a copy and nothing can reopen the viewer later.
   */
  const closeViewer = () => {
    viewerGeneration.current += 1;
    setViewer({ kind: 'closed' });
  };

  const back = (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={onBack}
      style={[styles.button, busy && styles.buttonDisabled]}
    >
      <Text style={styles.buttonText}>Back to trip</Text>
    </Pressable>
  );

  if (state.kind === 'loading') {
    return (
      <View style={styles.container}>
        <ActivityIndicator accessibilityLabel="Loading expense" />
      </View>
    );
  }

  if (state.kind === 'missing') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Expense not found</Text>
        <Text style={styles.line}>This expense is no longer available.</Text>
        {back}
      </View>
    );
  }

  if (state.kind === 'error') {
    return (
      <View style={styles.container}>
        <Text accessibilityRole="alert" style={styles.error}>
          {state.message}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={reload}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
        {back}
      </View>
    );
  }

  const current = state.expense;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>{formatPhp(current.amount)}</Text>

      <Text style={styles.line}>Status: {current.status}</Text>
      <Text style={styles.line}>Category: {current.category}</Text>
      <Text style={styles.line}>
        Incurred: {formatTripTime(current.incurredAt)}
      </Text>
      <Text style={styles.line}>
        Description:{' '}
        {current.description === '' ? NO_TIME : current.description}
      </Text>
      <Text style={styles.line}>
        Reviewed at: {formatTripTime(current.reviewedAt)}
      </Text>
      {/* The only feedback a rejected expense carries. */}
      <Text style={styles.line}>
        Review note: {current.reviewNote === '' ? NO_TIME : current.reviewNote}
      </Text>

      <Text style={styles.heading}>Receipt</Text>

      {receipt.kind === 'loading' ? (
        <ActivityIndicator accessibilityLabel="Loading receipt" />
      ) : null}

      {receipt.kind === 'error' ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {receipt.message}
        </Text>
      ) : null}

      {receipt.kind === 'none' ? (
        <Text style={styles.line}>No receipt attached.</Text>
      ) : null}

      {receipt.kind === 'pending' ? (
        <Text style={styles.line}>Receipt uploaded but not yet confirmed.</Text>
      ) : null}

      {receipt.kind === 'confirmed' ? (
        <Text style={styles.line}>
          Receipt confirmed {formatTripTime(receipt.receipt.confirmedAt)}.
        </Text>
      ) : null}

      {/* An expense that has been reviewed is closed to receipt changes, so
          no control is offered rather than one that would be refused. */}
      {open && receipt.kind === 'none' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: busy }}
          disabled={busy}
          onPress={() => {
            void attach();
          }}
          style={[styles.button, busy && styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>Choose receipt</Text>
        </Pressable>
      ) : null}

      {open && receipt.kind === 'pending' ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: busy }}
            disabled={busy}
            onPress={() => {
              void confirmPending();
            }}
            style={[styles.button, busy && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>Confirm receipt</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: busy }}
            disabled={busy}
            onPress={() => {
              void attach();
            }}
            style={[styles.button, busy && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>Choose receipt again</Text>
          </Pressable>
        </View>
      ) : null}

      {receipt.kind === 'confirmed' ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void viewReceipt();
          }}
          style={styles.button}
        >
          <Text style={styles.buttonText}>View receipt</Text>
        </Pressable>
      ) : null}

      {actionError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {actionError}
        </Text>
      ) : null}
      {outcome ? <Text style={styles.outcome}>{outcome}</Text> : null}

      {back}

      <Modal
        animationType="fade"
        onRequestClose={closeViewer}
        visible={viewer.kind !== 'closed'}
      >
        <View style={styles.viewer}>
          {viewer.kind === 'loading' ? (
            <ActivityIndicator accessibilityLabel="Opening receipt" />
          ) : null}
          {viewer.kind === 'open' ? (
            <Image
              accessibilityLabel="Receipt image"
              onError={() =>
                setViewer({
                  kind: 'error',
                  message: 'The receipt could not be shown. Try again.',
                })
              }
              resizeMode="contain"
              source={{ uri: viewer.url }}
              style={styles.image}
            />
          ) : null}
          {viewer.kind === 'error' ? (
            <View>
              <Text accessibilityRole="alert" style={styles.viewerError}>
                {viewer.message}
              </Text>
              {/* A retry mints a new authorization; the old URL is gone. */}
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  void viewReceipt();
                }}
                style={styles.button}
              >
                <Text style={styles.buttonText}>Try again</Text>
              </Pressable>
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={closeViewer}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Close receipt</Text>
          </Pressable>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    padding: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 16,
  },
  heading: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 20,
  },
  line: {
    fontSize: 16,
    marginBottom: 6,
  },
  error: {
    color: '#8a1f1f',
    fontSize: 16,
    marginTop: 12,
  },
  outcome: {
    color: '#1f5c2e',
    fontSize: 16,
    marginTop: 12,
  },
  button: {
    alignItems: 'center',
    borderColor: '#1f4e79',
    borderRadius: 4,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 48,
    paddingHorizontal: 16,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#1f4e79',
    fontSize: 16,
    fontWeight: '600',
  },
  viewer: {
    backgroundColor: '#000000',
    flex: 1,
    justifyContent: 'center',
    padding: 16,
  },
  image: {
    flex: 1,
    width: '100%',
  },
  viewerError: {
    color: '#ffb4b4',
    fontSize: 16,
    textAlign: 'center',
  },
});
