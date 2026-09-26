import type { Trip } from '@mansar/types';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { DriverExpensesApi } from '../expenses/driver-expenses-api';
import { ExpenseDetailView } from '../expenses/ExpenseDetailView';
import { TripExpensesSection } from '../expenses/TripExpensesSection';
import type { DriverReceiptsApi } from '../receipts/driver-receipts-api';
import {
  driverTripMessage,
  isTripNotFound,
  TRIP_FALLBACK,
} from '../trips/driver-trip-messages';
import type { DriverTripsApi } from '../trips/driver-trips-api';
import { formatTripTime, NO_TIME } from '../trips/trip-time';

interface Props {
  readonly tripId: string;
  readonly api: DriverTripsApi;
  readonly expensesApi: DriverExpensesApi;
  readonly receiptsApi: DriverReceiptsApi;
  readonly onBack: () => void;
}

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly trip: Trip }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly message: string };

/** The one mutation a status offers the driver, if any. */
interface Action {
  readonly label: string;
  readonly question: string;
  readonly confirmLabel: string;
  readonly keepLabel: string;
  readonly outcome: string;
  readonly fallback: string;
  readonly run: (tripId: string) => Promise<Trip>;
}

/** What a status with no driver action has to say for itself. */
function statusNote(status: Trip['status']): string | null {
  switch (status) {
    case 'DRAFT':
      return 'This trip has not been assigned.';
    case 'COMPLETED':
      return 'Trip completed. Waiting for admin verification.';
    case 'VERIFIED':
      return 'This trip has been verified.';
    case 'CLOSED':
      return 'This trip is closed.';
    case 'CANCELLED':
      return 'This trip is cancelled.';
    default:
      return null;
  }
}

/**
 * One of the driver's own trips, with the single action its state allows.
 *
 * Start and complete are the only mutations a driver has. There is no create,
 * edit, assign, reschedule, cancel, verify or close here: those are admin
 * operations and the driver API refuses them, so no button offers them.
 *
 * Whether to *show* an action is decided from the current status; whether it
 * is *allowed* is the API's decision alone. Nothing is changed optimistically
 * and no backend rule — a fresh driver or vehicle status, ownership, the
 * one-running-trip indexes — is second-guessed here.
 */
export function DriverTripDetailScreen({
  tripId,
  api,
  expensesApi,
  receiptsApi,
  onBack,
}: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Expense navigation is local to this screen, exactly as trip selection is
  // local to App: one id, no router, and it disappears when this unmounts.
  const [selectedExpenseId, setSelectedExpenseId] = useState<string | null>(
    null,
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  // Signing out unmounts this screen while a mutation may still be in
  // flight; its continuation must not then touch state.
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
        const trip = await api.get(tripId);
        if (!cancelled) {
          setState({ kind: 'ready', trip });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setState(
          isTripNotFound(error)
            ? { kind: 'missing' }
            : {
                kind: 'error',
                message: driverTripMessage(error, TRIP_FALLBACK.detail),
              },
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, tripId, attempt]);

  const trip = state.kind === 'ready' ? state.trip : null;

  const action: Action | null =
    trip === null
      ? null
      : trip.status === 'ASSIGNED'
        ? {
            label: 'Start trip',
            question: 'Start this trip?',
            confirmLabel: 'Confirm start',
            keepLabel: 'Keep trip assigned',
            outcome: 'Trip started.',
            fallback: TRIP_FALLBACK.start,
            run: (id) => api.start(id),
          }
        : trip.status === 'IN_PROGRESS'
          ? {
              label: 'Complete trip',
              question: 'Complete this trip?',
              confirmLabel: 'Confirm completion',
              keepLabel: 'Keep trip in progress',
              outcome: 'Trip completed.',
              fallback: TRIP_FALLBACK.complete,
              run: (id) => api.complete(id),
            }
          : null;

  const apply = async () => {
    if (action === null || busy) {
      return;
    }
    setBusy(true);
    setActionError(null);
    setOutcome(null);
    try {
      const updated = await action.run(tripId);
      if (!mounted.current) {
        return;
      }
      // The response is the authority on the new state.
      setState({ kind: 'ready', trip: updated });
      setOutcome(action.outcome);
    } catch (error) {
      if (!mounted.current) {
        return;
      }
      // The last authoritative trip is kept exactly as it was.
      setActionError(driverTripMessage(error, action.fallback));
    }
    setBusy(false);
    setConfirming(false);
  };

  const retry = () => {
    setState({ kind: 'loading' });
    setAttempt((previous) => previous + 1);
  };

  // Leaving mid-mutation would race the request against a freshly mounted
  // list, so the way out is closed until the request settles.
  const back = (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={onBack}
      style={[styles.button, busy && styles.buttonDisabled]}
    >
      <Text style={styles.buttonText}>Back to trips</Text>
    </Pressable>
  );

  // One expense, in place of the trip body. The trip's own state is kept
  // mounted-in-memory above, so returning lands on the same trip without a
  // second request and without any App-level route.
  if (selectedExpenseId !== null) {
    return (
      <ExpenseDetailView
        expenseId={selectedExpenseId}
        expensesApi={expensesApi}
        onBack={() => setSelectedExpenseId(null)}
        receiptsApi={receiptsApi}
      />
    );
  }

  if (state.kind === 'loading') {
    return (
      <View style={styles.container}>
        <ActivityIndicator accessibilityLabel="Loading trip" />
      </View>
    );
  }

  if (state.kind === 'missing') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Trip not found</Text>
        <Text style={styles.line}>This trip is no longer available.</Text>
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
          onPress={retry}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
        {back}
      </View>
    );
  }

  const note = statusNote(state.trip.status);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>
        {state.trip.origin} → {state.trip.destination}
      </Text>

      <Text style={styles.line}>Status: {state.trip.status}</Text>
      <Text style={styles.line}>Origin: {state.trip.origin}</Text>
      <Text style={styles.line}>Destination: {state.trip.destination}</Text>
      <Text style={styles.line}>
        Scheduled start: {formatTripTime(state.trip.scheduledStartAt)}
      </Text>
      <Text style={styles.line}>
        Scheduled end: {formatTripTime(state.trip.scheduledEndAt)}
      </Text>
      <Text style={styles.line}>
        Started: {formatTripTime(state.trip.startedAt)}
      </Text>
      <Text style={styles.line}>
        Completed: {formatTripTime(state.trip.completedAt)}
      </Text>
      <Text style={styles.line}>
        Notes: {state.trip.notes === '' ? NO_TIME : state.trip.notes}
      </Text>

      {note ? <Text style={styles.note}>{note}</Text> : null}

      <TripExpensesSection
        api={expensesApi}
        onOpenExpense={setSelectedExpenseId}
        tripId={tripId}
        tripStatus={state.trip.status}
      />

      {action && !confirming ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: busy }}
          disabled={busy}
          onPress={() => setConfirming(true)}
          style={[styles.button, busy && styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>{action.label}</Text>
        </Pressable>
      ) : null}

      {action && confirming ? (
        <View>
          <Text style={styles.line}>{action.question}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: busy }}
            disabled={busy}
            onPress={() => {
              void apply();
            }}
            style={[styles.button, busy && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>{action.confirmLabel}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => setConfirming(false)}
            style={[styles.button, busy && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>{action.keepLabel}</Text>
          </Pressable>
        </View>
      ) : null}

      {actionError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {actionError}
        </Text>
      ) : null}
      {outcome ? <Text style={styles.outcome}>{outcome}</Text> : null}

      {back}
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
  line: {
    fontSize: 16,
    marginBottom: 6,
  },
  note: {
    fontSize: 16,
    marginBottom: 6,
    marginTop: 10,
    opacity: 0.8,
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
});
