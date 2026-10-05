import type { Trip } from '@mansar/types';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Component, type ReactNode, useState } from 'react';
import { AppState, type AppStateStatus, Pressable, Text } from 'react-native';

import { LocationProvider, useLocationLifecycle } from './location-context';
import type {
  TrackingProjection,
  TripLocationOrchestrator,
} from './trip-location-orchestrator';

/**
 * Who owns the lifecycle, and for how long.
 *
 * The provider sits above the home/detail swap, so the facts under test are
 * ownership facts: exactly one orchestrator per mount, exactly one `AppState`
 * listener, both surviving a navigation, both released on unmount. A second
 * orchestrator would mean two drains competing for one queue; a second
 * listener would mean two reconciliations per foreground; a listener that
 * outlived the mount would keep calling a disposed lifecycle.
 */

const PROJECTION: TrackingProjection = {
  phase: 'inactive',
  tripId: null,
  permission: 'precise',
  locationServicesEnabled: true,
  playServicesAvailable: true,
  notificationsEnabled: true,
  pendingCount: 0,
  droppedCount: 0,
  nativeErrorCode: null,
  drainOutcome: null,
  completionUnknown: false,
  problem: null,
  signingOut: false,
  busy: false,
};

const TRIP = { id: 'trip-1', status: 'IN_PROGRESS' } as unknown as Trip;

/** An orchestrator that records calls and can publish new state at will. */
function createFakeOrchestrator(
  onChange?: (projection: TrackingProjection) => void,
) {
  const calls: string[] = [];
  let current = PROJECTION;
  const orchestrator: TripLocationOrchestrator = {
    state: () => current,
    initialize: async () => {
      calls.push('initialize');
    },
    startTrip: async () => {
      calls.push('startTrip');
      return TRIP;
    },
    completeTrip: async () => {
      calls.push('completeTrip');
      return TRIP;
    },
    signOut: async () => {
      calls.push('signOut');
    },
    retryReconcile: async () => {
      calls.push('retryReconcile');
    },
    requestOrRetryTracking: async () => {
      calls.push('requestOrRetryTracking');
    },
    acknowledgeDroppedSamples: async () => {
      calls.push('acknowledgeDroppedSamples');
    },
    onForeground: async () => {
      calls.push('onForeground');
    },
    dispose: () => {
      calls.push('dispose');
    },
  };
  return {
    orchestrator,
    calls,
    count: (call: string) => calls.filter((one) => one === call).length,
    publish: (next: Partial<TrackingProjection>) => {
      current = { ...current, ...next };
      onChange?.(current);
    },
  };
}

/**
 * Captures the single AppState listener the provider is allowed to add.
 *
 * `remove()` really stops delivery here, as the platform's does: a fake
 * that kept delivering after removal would make the teardown proof
 * meaningless.
 */
function captureAppState() {
  interface Entry {
    readonly handler: (state: AppStateStatus) => void;
    readonly remove: jest.Mock;
    removed: boolean;
  }
  const entries: Entry[] = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((type, handler) => {
      expect(type).toBe('change');
      const entry: Entry = {
        handler: handler as (state: AppStateStatus) => void,
        remove: jest.fn(() => {
          entry.removed = true;
        }),
        removed: false,
      };
      entries.push(entry);
      return { remove: entry.remove } as unknown as ReturnType<
        typeof AppState.addEventListener
      >;
    });
  return {
    /** Every subscription ever created, removed or not. */
    entries,
    removes: {
      get: (index: number) => entries[index]?.remove,
    },
    emit: async (state: AppStateStatus) => {
      await act(async () => {
        for (const entry of entries) {
          if (!entry.removed) {
            entry.handler(state);
          }
        }
      });
    },
  };
}

function Probe() {
  const location = useLocationLifecycle();
  return (
    <>
      <Text>{`phase: ${location.state.phase}`}</Text>
      <Text>{`pending: ${location.state.pendingCount}`}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void location.signOut();
        }}
      >
        <Text>Sign out</Text>
      </Pressable>
    </>
  );
}

/** Catches a render error the way a real tree would. */
class Boundary extends Component<
  { readonly onError: (error: Error) => void; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  override render() {
    return this.state.failed ? <Text>caught</Text> : this.props.children;
  }
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('LocationProvider ownership', () => {
  it('builds one orchestrator and initializes it once', async () => {
    const appState = captureAppState();
    let built = 0;
    let fake = createFakeOrchestrator();
    const create = (onChange: (projection: TrackingProjection) => void) => {
      built += 1;
      fake = createFakeOrchestrator(onChange);
      return fake.orchestrator;
    };

    await render(
      <LocationProvider create={create}>
        <Probe />
      </LocationProvider>,
    );

    expect(built).toBe(1);
    expect(fake.count('initialize')).toBe(1);
    expect(appState.entries).toHaveLength(1);
  });

  it('keeps one orchestrator and one listener across a navigation', async () => {
    const appState = captureAppState();
    let built = 0;
    const create = () => {
      built += 1;
      return createFakeOrchestrator().orchestrator;
    };

    // The provider sits above the screen swap, exactly as the app wires it.
    function Flow() {
      const [detail, setDetail] = useState(false);
      return (
        <LocationProvider create={create}>
          {detail ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setDetail(false)}
            >
              <Text>Back</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => setDetail(true)}
            >
              <Text>Open trip</Text>
            </Pressable>
          )}
        </LocationProvider>
      );
    }

    await render(<Flow />);
    await fireEvent.press(screen.getByRole('button', { name: 'Open trip' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Open trip' }));

    // A rebuild here would start a second drain against one queue, and Back
    // would destroy a running capture session.
    expect(built).toBe(1);
    expect(appState.entries).toHaveLength(1);
    expect(appState.removes.get(0)).not.toHaveBeenCalled();
  });

  it('disposes the orchestrator and removes the listener on unmount', async () => {
    const appState = captureAppState();
    const fake = createFakeOrchestrator();
    const view = await render(
      <LocationProvider create={() => fake.orchestrator}>
        <Probe />
      </LocationProvider>,
    );

    expect(fake.calls).not.toContain('dispose');
    await act(async () => {
      view.unmount();
    });

    expect(fake.count('dispose')).toBe(1);
    expect(appState.removes.get(0)).toHaveBeenCalledTimes(1);
    expect(appState.entries).toHaveLength(1);
  });
});

describe('foreground notification', () => {
  it('calls onForeground only for an active app state', async () => {
    const appState = captureAppState();
    const fake = createFakeOrchestrator();
    await render(
      <LocationProvider create={() => fake.orchestrator}>
        <Probe />
      </LocationProvider>,
    );

    await appState.emit('background');
    await appState.emit('inactive');
    // Backgrounding is not a lifecycle event here: native capture continues,
    // and nothing is stopped or paused for it.
    expect(fake.calls).not.toContain('onForeground');

    await appState.emit('active');
    expect(fake.count('onForeground')).toBe(1);

    await appState.emit('active');
    expect(fake.count('onForeground')).toBe(2);
  });

  it('notifies nothing after unmount', async () => {
    const appState = captureAppState();
    const fake = createFakeOrchestrator();
    const view = await render(
      <LocationProvider create={() => fake.orchestrator}>
        <Probe />
      </LocationProvider>,
    );
    await act(async () => {
      view.unmount();
    });
    expect(fake.calls).toContain('dispose');

    await appState.emit('active');
    expect(fake.calls).not.toContain('onForeground');
  });
});

describe('published state', () => {
  it('renders the orchestrator state and every update to it', async () => {
    captureAppState();
    let fake = createFakeOrchestrator();
    await render(
      <LocationProvider
        create={(onChange) => {
          fake = createFakeOrchestrator(onChange);
          return fake.orchestrator;
        }}
      >
        <Probe />
      </LocationProvider>,
    );

    expect(screen.getByText('phase: inactive')).toBeTruthy();

    await act(async () => {
      fake.publish({ phase: 'active', pendingCount: 3 });
    });
    expect(screen.getByText('phase: active')).toBeTruthy();
    expect(screen.getByText('pending: 3')).toBeTruthy();
  });

  it('exposes the actions without exposing the orchestrator', async () => {
    captureAppState();
    const fake = createFakeOrchestrator();
    await render(
      <LocationProvider create={() => fake.orchestrator}>
        <Probe />
      </LocationProvider>,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(fake.count('signOut')).toBe(1);
  });
});

describe('useLocationLifecycle outside a provider', () => {
  it('throws rather than silently doing nothing', async () => {
    // A screen that reached this hook without the provider would otherwise
    // render tracking controls wired to nothing at all.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const caught: Error[] = [];

    await render(
      <Boundary onError={(error) => caught.push(error)}>
        <Probe />
      </Boundary>,
    );

    expect(caught).toHaveLength(1);
    expect(caught[0]?.message).toMatch(
      /must be used within a LocationProvider/,
    );
    expect(screen.getByText('caught')).toBeTruthy();
    spy.mockRestore();
  });
});
