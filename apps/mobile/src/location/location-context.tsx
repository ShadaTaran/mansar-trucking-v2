import type { Trip } from '@mansar/types';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import type {
  TrackingProjection,
  TripLocationOrchestrator,
} from './trip-location-orchestrator';

/**
 * React access to the location lifecycle.
 *
 * The provider is the ownership point: it builds exactly one orchestrator per
 * mount, keeps it for the life of that mount, and disposes it when the mount
 * ends. Because it sits above the home/detail swap, moving between those
 * screens — and pressing Back — re-renders children without touching the
 * orchestrator, the drain or the native session. That is the whole reason this
 * lives here and not in a screen.
 *
 * It also owns the single `AppState` subscription. One listener, in one place,
 * added and removed with the orchestrator, is what keeps a navigation from
 * registering a second one or a screen unmount from removing the first.
 *
 * A screen receives projected state and stable actions. It never receives the
 * native module, the drain, the session or a token.
 */

export interface LocationLifecycle {
  readonly state: TrackingProjection;
  /** Starts the trip server-side, then establishes capture if it applied. */
  startTrip(tripId: string): Promise<Trip>;
  /** Pauses capture, drains one batch, completes, then reconciles. */
  completeTrip(tripId: string): Promise<Trip>;
  /** Stops capture, drains once while authenticated, then logs out. */
  signOut(): Promise<void>;
  /** Re-runs reconciliation, or resolves an unknown completion. */
  retryReconcile(): Promise<void>;
  /** Prompts for permission, then tries to establish capture again. */
  requestOrRetryTracking(): Promise<void>;
  /** The only path that clears a dropped-sample count. */
  acknowledgeDroppedSamples(): Promise<void>;
}

const LocationContext = createContext<LocationLifecycle | null>(null);

export interface LocationProviderProps {
  /**
   * Builds the orchestrator, given the callback that publishes its state.
   *
   * A factory rather than a ready-made instance so the provider can wire its
   * own `setState` as the subscription — the orchestrator is framework-free
   * and publishes through a plain callback, and this is where that callback
   * becomes a React render.
   */
  readonly create: (
    onChange: (projection: TrackingProjection) => void,
  ) => TripLocationOrchestrator;
  readonly children: ReactNode;
}

export function LocationProvider({ create, children }: LocationProviderProps) {
  const [published, setPublished] = useState<TrackingProjection | null>(null);
  // Built once per mount, by a lazy initializer rather than a ref: a
  // re-render from navigation must find this same orchestrator, and with it
  // the same drain and the same native session, instead of a second one.
  const [orchestrator] = useState<TripLocationOrchestrator>(() =>
    create((projection) => {
      setPublished(projection);
    }),
  );

  useEffect(() => {
    // No seeding setState: until the first projection is published, the
    // render below reads the orchestrator's own initial state.
    //
    // The order of the three steps below is load-bearing.
    const onChange = (next: AppStateStatus) => {
      if (next === 'active') {
        // A recovery trigger, not the tracking mechanism: the foreground
        // service keeps capturing through Home, an app switch and a screen
        // lock, and nothing here stops or pauses it for backgrounding.
        void orchestrator.onForeground();
      } else {
        // Everything that is not `active` — `background`, `inactive`, and
        // whatever a future platform adds — hands drain opportunities to the
        // native kick. Treating only a known list as background would leave an
        // unrecognised state believing it still owned foreground timers.
        orchestrator.onBackground();
      }
    };
    // 1. The listener is registered first, so a transition that happens while
    //    this effect is still running is delivered rather than missed.
    const subscription = AppState.addEventListener('change', onChange);
    // 2. Then the real initial state. Mounting is not evidence of being in
    //    front of the driver: bootstrap is asynchronous, so this provider can
    //    mount while the app is already away. `currentState` is null until the
    //    first native read, and an unknown state is taken as background,
    //    which is the direction that fails safe.
    orchestrator.syncAppForeground(AppState.currentState === 'active');
    // 3. Only then initialize, which now knows whether it owns the foreground.
    void orchestrator.initialize();
    return () => {
      subscription.remove();
      orchestrator.dispose();
    };
  }, [orchestrator]);

  const state = published ?? orchestrator.state();

  const value = useMemo<LocationLifecycle>(
    () => ({
      state,
      startTrip: (tripId) => orchestrator.startTrip(tripId),
      completeTrip: (tripId) => orchestrator.completeTrip(tripId),
      signOut: () => orchestrator.signOut(),
      retryReconcile: () => orchestrator.retryReconcile(),
      requestOrRetryTracking: () => orchestrator.requestOrRetryTracking(),
      acknowledgeDroppedSamples: () => orchestrator.acknowledgeDroppedSamples(),
    }),
    [orchestrator, state],
  );

  return (
    <LocationContext.Provider value={value}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocationLifecycle(): LocationLifecycle {
  const value = useContext(LocationContext);
  if (value === null) {
    throw new Error(
      'useLocationLifecycle must be used within a LocationProvider',
    );
  }
  return value;
}
