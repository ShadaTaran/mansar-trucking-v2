import type { AuthUser } from '@mansar/api-client';
import type { Page, Trip, TripStatus } from '@mansar/types';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useLocationLifecycle } from '../location/location-context';
import { TrackingStatusSection } from '../location/TrackingStatusSection';
import {
  driverTripMessage,
  TRIP_FALLBACK,
} from '../trips/driver-trip-messages';
import type { DriverTripsApi } from '../trips/driver-trips-api';
import { formatTripTime } from '../trips/trip-time';

export const PAGE_SIZE = 25;

/**
 * DRAFT is absent on purpose: a trip only becomes a driver's once it is
 * assigned, so an owned DRAFT trip cannot exist under the Stage 5A contract.
 */
const FILTERS: ReadonlyArray<{
  readonly label: string;
  readonly status: TripStatus | null;
}> = [
  { label: 'All', status: null },
  { label: 'Assigned', status: 'ASSIGNED' },
  { label: 'In progress', status: 'IN_PROGRESS' },
  { label: 'Completed', status: 'COMPLETED' },
  { label: 'Verified', status: 'VERIFIED' },
  { label: 'Closed', status: 'CLOSED' },
  { label: 'Cancelled', status: 'CANCELLED' },
];

/** What to ask the API for. `nonce` lets a retry repeat the same request. */
interface ListRequest {
  readonly status: TripStatus | null;
  readonly page: number;
  readonly nonce: number;
}

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly page: Page<Trip> }
  | { readonly kind: 'error'; readonly message: string };

const INITIAL_REQUEST: ListRequest = { status: null, page: 1, nonce: 0 };

/**
 * Shown when the lifecycle refused to sign out.
 *
 * Fixed wording, never a native or platform message: the driver needs to
 * know they are *still signed in* and that retrying is the next step, and
 * nothing about why the device could not stop its own service.
 */
export const SIGN_OUT_BLOCKED_MESSAGE =
  'Tracking could not be stopped, so you are still signed in. Try again.';

interface Props {
  readonly user: AuthUser;
  readonly api: DriverTripsApi;
  readonly onOpenTrip: (tripId: string) => void;
}

/**
 * The driver's home: their own trips, in the order the API returns them.
 *
 * Only `/driver/trips` is called — the endpoint returns a flat Trip on
 * purpose, so there is no per-row driver or vehicle lookup and no N+1. The
 * list is server-paged and server-filtered; a page that has already been
 * loaded is never filtered again in the client.
 */
export function DriverHomeScreen({ user, api, onOpenTrip }: Props) {
  const location = useLocationLifecycle();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [request, setRequest] = useState<ListRequest>(INITIAL_REQUEST);
  const [state, setState] = useState<ListState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.list({
          ...(request.status === null ? {} : { status: request.status }),
          page: request.page,
          pageSize: PAGE_SIZE,
        });
        // A slower earlier request cannot overwrite a newer one, and an
        // unmounted screen is never updated.
        if (!cancelled) {
          setState({ kind: 'ready', page: result });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: driverTripMessage(error, TRIP_FALLBACK.list),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, request]);

  /** Every navigation shows the loading state before the request starts. */
  const apply = (next: Omit<ListRequest, 'nonce'>) => {
    setState({ kind: 'loading' });
    setRequest({ ...next, nonce: request.nonce + 1 });
  };

  const logout = async () => {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    setSignOutError(null);
    // Deliberately not `session.logout()`. Signing out has to stop capture and
    // upload whatever is still queued *while the credentials exist*, and only
    // the orchestrator can order those steps; clearing auth first would make
    // the final upload impossible and would unmount this screen before it
    // could run. Clearing auth is the last thing that orchestration does.
    try {
      await location.signOut();
      // On success this screen is unmounted by the auth state change, so
      // nothing is reset here.
    } catch {
      // The lifecycle refused, which means capture could not be proven
      // stopped and the driver is still authenticated. The only safe thing
      // to show is a fixed sentence and a usable button.
      setSignOutError(SIGN_OUT_BLOCKED_MESSAGE);
      setSigningOut(false);
    }
  };

  const total = state.kind === 'ready' ? state.page.total : 0;
  const page = state.kind === 'ready' ? state.page.page : request.page;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const onFirstPage = request.page <= 1;
  const onLastPage = page * PAGE_SIZE >= total;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Mansar Driver</Text>
      <Text style={styles.line}>Signed in as {user.email}</Text>
      <Text style={styles.line}>Role: {user.role}</Text>

      <TrackingStatusSection
        onAcknowledgeGap={() => {
          void location.acknowledgeDroppedSamples();
        }}
        onEnableTracking={() => {
          void location.requestOrRetryTracking();
        }}
        onRetry={() => {
          void location.retryReconcile();
        }}
        state={location.state}
      />

      <Text style={styles.heading}>My trips</Text>

      <View style={styles.filters}>
        {FILTERS.map((filter) => {
          const selected = request.status === filter.status;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={filter.label}
              onPress={() => apply({ status: filter.status, page: 1 })}
              style={[styles.filter, selected && styles.filterSelected]}
            >
              <Text style={styles.filterText}>{filter.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {state.kind === 'loading' ? (
        <ActivityIndicator accessibilityLabel="Loading trips" />
      ) : null}

      {state.kind === 'error' ? (
        <View>
          <Text accessibilityRole="alert" style={styles.error}>
            {state.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              apply({ status: request.status, page: request.page })
            }
            style={styles.button}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {state.kind === 'ready' ? (
        state.page.items.length === 0 ? (
          <Text style={styles.line}>No trips found.</Text>
        ) : (
          <View>
            {state.page.items.map((trip) => (
              <Pressable
                accessibilityRole="button"
                key={trip.id}
                onPress={() => onOpenTrip(trip.id)}
                style={styles.card}
              >
                <Text style={styles.cardTitle}>
                  {trip.origin} → {trip.destination}
                </Text>
                <Text style={styles.cardLine}>Status: {trip.status}</Text>
                <Text style={styles.cardLine}>
                  Scheduled start: {formatTripTime(trip.scheduledStartAt)}
                </Text>
                <Text style={styles.cardLine}>
                  Scheduled end: {formatTripTime(trip.scheduledEndAt)}
                </Text>
              </Pressable>
            ))}
            <Text style={styles.line}>
              Page {page} of {lastPage}
            </Text>
            <View style={styles.pager}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: onFirstPage }}
                disabled={onFirstPage}
                onPress={() =>
                  apply({ status: request.status, page: request.page - 1 })
                }
                style={[styles.button, onFirstPage && styles.buttonDisabled]}
              >
                <Text style={styles.buttonText}>Previous</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: onLastPage }}
                disabled={onLastPage}
                onPress={() =>
                  apply({ status: request.status, page: request.page + 1 })
                }
                style={[styles.button, onLastPage && styles.buttonDisabled]}
              >
                <Text style={styles.buttonText}>Next</Text>
              </Pressable>
            </View>
          </View>
        )
      ) : null}

      {signOutError === null ? null : (
        <Text accessibilityRole="alert" style={styles.error}>
          {signOutError}
        </Text>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy: signingOut, disabled: signingOut }}
        disabled={signingOut}
        onPress={() => {
          void logout();
        }}
        style={[styles.button, signingOut && styles.buttonDisabled]}
      >
        <Text style={styles.buttonText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    padding: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 16,
  },
  heading: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
    marginTop: 16,
  },
  line: {
    fontSize: 16,
    marginBottom: 4,
  },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  filter: {
    borderColor: '#1f4e79',
    borderRadius: 4,
    borderWidth: 1,
    marginBottom: 6,
    marginRight: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  filterSelected: {
    backgroundColor: '#e3edf7',
  },
  filterText: {
    color: '#1f4e79',
    fontSize: 14,
  },
  card: {
    borderColor: '#c8d4e0',
    borderRadius: 4,
    borderWidth: 1,
    marginBottom: 12,
    padding: 12,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  cardLine: {
    fontSize: 14,
    marginBottom: 2,
  },
  error: {
    color: '#8a1f1f',
    fontSize: 16,
    marginBottom: 12,
  },
  pager: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  button: {
    alignItems: 'center',
    borderColor: '#1f4e79',
    borderRadius: 4,
    borderWidth: 1,
    justifyContent: 'center',
    marginRight: 8,
    marginTop: 8,
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
