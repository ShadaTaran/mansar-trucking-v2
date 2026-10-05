import { fireEvent, render, screen } from '@testing-library/react-native';

import type { DrainOutcome } from './location-drain';
import { TrackingStatusSection } from './TrackingStatusSection';
import type {
  TrackingPhase,
  TrackingProblem,
  TrackingProjection,
} from './trip-location-orchestrator';

/**
 * What the driver is actually told.
 *
 * Two kinds of claim are tested. First, that every state has a sentence: a
 * phase, a blocker, an upload state and a coverage gap each produce something
 * a driver can read and act on, because an unexplained "not tracking" is how a
 * driver loses a day's journey without knowing. Second, that nothing else gets
 * out — no coordinate, no instant, no sample or trip id, no platform exception
 * text — since this section is the one place tracking internals could leak
 * into the UI.
 */

const BASE: TrackingProjection = {
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

const state = (over: Partial<TrackingProjection> = {}): TrackingProjection => ({
  ...BASE,
  ...over,
});

async function renderSection(over: Partial<TrackingProjection> = {}) {
  const onRetry = jest.fn();
  const onEnableTracking = jest.fn();
  const onAcknowledgeGap = jest.fn();
  await render(
    <TrackingStatusSection
      onAcknowledgeGap={onAcknowledgeGap}
      onEnableTracking={onEnableTracking}
      onRetry={onRetry}
      state={state(over)}
    />,
  );
  return { onRetry, onEnableTracking, onAcknowledgeGap };
}

/** Every string the section rendered, joined. */
function renderedText(): string {
  const collect = (node: unknown): string[] => {
    if (typeof node === 'string') {
      return [node];
    }
    if (Array.isArray(node)) {
      return node.flatMap(collect);
    }
    if (node !== null && typeof node === 'object' && 'children' in node) {
      return collect((node as { readonly children: unknown }).children);
    }
    return [];
  };
  return collect(screen.toJSON()).join(' ');
}

describe('headline', () => {
  it.each<[TrackingPhase, string]>([
    ['initializing', 'Checking your trip status'],
    ['reconciling', 'Checking your trip status'],
    ['active', 'Tracking this trip'],
    ['paused', 'Tracking paused'],
    ['inactive', 'Not tracking — no trip in progress'],
    ['unavailable', 'Tracking unavailable'],
    ['failed', 'Tracking needs attention'],
  ])('says something definite while %s', async (phase, expected) => {
    await renderSection({ phase });
    expect(screen.getByText(new RegExp(expected))).toBeTruthy();
  });

  it('never claims the session stopped when failing closed', async () => {
    await renderSection({ phase: 'failed', problem: 'multiple_active_trips' });

    // Failing closed may have *paused* the exact native session rather than
    // stopping it — pausing is what keeps a resume possible — so the
    // headline must not describe a stop this app cannot vouch for.
    expect(screen.getByText('Tracking needs attention')).toBeTruthy();
    const text = renderedText();
    expect(text).not.toMatch(/Tracking stopped/);
    expect(text).not.toMatch(/Not tracking/);

    // The actionable part is unchanged.
    expect(screen.getByText(/More than one trip is in progress/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Check trip status' }),
    ).toBeTruthy();
  });

  it('still says plainly when nothing is being recorded', async () => {
    // `inactive` is published only after a confirmed stop, so this one is
    // allowed to be definite.
    await renderSection({ phase: 'inactive' });
    expect(screen.getByText('Not tracking — no trip in progress')).toBeTruthy();
  });

  it('leads with an unconfirmed completion whatever the phase', async () => {
    await renderSection({
      phase: 'paused',
      completionUnknown: true,
      tripId: 't',
    });

    // The driver pressed Complete and does not know whether it worked; that
    // outranks every other thing this section could say.
    expect(
      screen.getByText(/Completion not confirmed — tracking paused/),
    ).toBeTruthy();
    expect(screen.queryByText('Tracking paused')).toBeNull();
  });
});

describe('blockers', () => {
  it('explains a denied location permission', async () => {
    await renderSection({ permission: 'none', phase: 'unavailable' });
    expect(screen.getByText(/Location permission is required/)).toBeTruthy();
  });

  it('discloses approximate location without promising accuracy', async () => {
    await renderSection({ permission: 'approximate', phase: 'active' });
    const text = renderedText();
    expect(text).toMatch(/Approximate location only/);
    // The native filter judges each fix on the accuracy the device reported,
    // so no metre figure may be implied here.
    expect(text).not.toMatch(/\d+\s?m\b/);
  });

  it('explains disabled location services', async () => {
    await renderSection({
      locationServicesEnabled: false,
      phase: 'unavailable',
    });
    expect(screen.getByText(/Location services are switched off/)).toBeTruthy();
  });

  it('explains missing Play Services', async () => {
    await renderSection({ playServicesAvailable: false, phase: 'unavailable' });
    expect(
      screen.getByText(/Google Play Services is unavailable/),
    ).toBeTruthy();
  });

  it('presents denied notifications as a warning, not a blocker', async () => {
    await renderSection({ notificationsEnabled: false, phase: 'active' });
    const text = renderedText();
    expect(text).toMatch(/Notifications are off/);
    expect(text).toMatch(/Tracking still runs/);
    expect(text).toMatch(/Tracking this trip/);
  });

  it.each<[TrackingProblem, RegExp]>([
    ['multiple_active_trips', /More than one trip is in progress/],
    ['lookup_failed', /trip status could not be checked/],
    ['tracking_unavailable', /could not be started on this device/],
  ])('explains the %s problem', async (problem, expected) => {
    await renderSection({ problem, phase: 'failed' });
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it('says nothing about blockers when there are none', async () => {
    await renderSection({ phase: 'active', tripId: 't' });
    expect(renderedText()).not.toMatch(/required|switched off|unavailable/);
  });
});

describe('queued positions', () => {
  it('stays silent with an empty queue', async () => {
    await renderSection();
    expect(renderedText()).not.toMatch(/waiting to upload/);
  });

  it('counts one position in the singular', async () => {
    await renderSection({ pendingCount: 1 });
    expect(
      screen.getByText(/1 recorded position waiting to upload/),
    ).toBeTruthy();
  });

  it('counts many positions in the plural', async () => {
    await renderSection({ pendingCount: 42 });
    expect(
      screen.getByText(/42 recorded positions waiting to upload/),
    ).toBeTruthy();
  });
});

describe('upload state', () => {
  const outcomes: ReadonlyArray<readonly [DrainOutcome, RegExp]> = [
    [{ kind: 'empty' }, /All recorded positions have been uploaded/],
    [
      {
        kind: 'progress',
        submittedCount: 10,
        deletedCount: 10,
        moreLikely: true,
      },
      /Uploading recorded positions/,
    ],
    [{ kind: 'retryable' }, /retry automatically/],
    [{ kind: 'blocked-auth' }, /sign in again/],
    [{ kind: 'blocked-protocol' }, /refused by the server.*kept/],
    [
      { kind: 'blocked-reconcile', tripId: 'trip-1' },
      /waiting on this trip being checked/,
    ],
    [{ kind: 'blocked-forbidden' }, /not permitted for this account.*kept/],
    [
      { kind: 'blocked-state', code: 'trip_not_trackable' },
      /paused until this trip can accept positions/,
    ],
    [{ kind: 'queue-error' }, /could not be read on this device/],
  ];

  it.each(outcomes)('has a sentence for %p', async (outcome, expected) => {
    await renderSection({ drainOutcome: outcome });
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it('says nothing before the first pass', async () => {
    await renderSection({ drainOutcome: null });
    expect(renderedText()).not.toMatch(/upload/i);
  });

  it('never prints a trip id from a reconcile block', async () => {
    await renderSection({
      drainOutcome: { kind: 'blocked-reconcile', tripId: 'trip-secret-1' },
    });
    expect(renderedText()).not.toContain('trip-secret-1');
  });

  it('never prints a server error code from a state block', async () => {
    await renderSection({
      drainOutcome: { kind: 'blocked-state', code: 'driver_not_linked' },
    });
    expect(renderedText()).not.toContain('driver_not_linked');
  });
});

describe('coverage gap', () => {
  it('offers no acknowledgement when nothing was lost', async () => {
    await renderSection({ droppedCount: 0 });
    expect(
      screen.queryByRole('button', { name: 'I understand the gap' }),
    ).toBeNull();
    expect(renderedText()).not.toMatch(/gap/);
  });

  it('states the gap and asks for an explicit acknowledgement', async () => {
    const handlers = await renderSection({
      droppedCount: 5,
      phase: 'active',
      tripId: 't',
    });

    expect(screen.getByText(/5 positions could not be stored/)).toBeTruthy();
    // The count is owner-scoped: the queue dropped observations for this
    // login without recording which journey each one belonged to, so the
    // sentence must not pin the gap on the trip being tracked right now.
    expect(
      screen.getByText(/your recorded location history has a gap/),
    ).toBeTruthy();
    expect(screen.queryByText(/this trip has a gap/)).toBeNull();
    expect(renderedText()).not.toMatch(/this trip has a gap/);

    // Nothing clears a gap on the driver's behalf: they are told, and they
    // say they understand.
    await fireEvent.press(
      screen.getByRole('button', { name: 'I understand the gap' }),
    );
    expect(handlers.onAcknowledgeGap).toHaveBeenCalledTimes(1);
    expect(handlers.onRetry).not.toHaveBeenCalled();
    expect(handlers.onEnableTracking).not.toHaveBeenCalled();
  });

  it('uses the singular for one lost position', async () => {
    await renderSection({ droppedCount: 1 });
    expect(screen.getByText(/1 position could not be stored/)).toBeTruthy();
  });
});

describe('actions', () => {
  it('offers to enable tracking when permission is missing', async () => {
    const handlers = await renderSection({ permission: 'none' });
    await fireEvent.press(
      screen.getByRole('button', { name: 'Enable tracking' }),
    );
    expect(handlers.onEnableTracking).toHaveBeenCalledTimes(1);
  });

  it('offers to enable tracking when the device refused it', async () => {
    await renderSection({
      phase: 'unavailable',
      problem: 'tracking_unavailable',
    });
    expect(
      screen.getByRole('button', { name: 'Enable tracking' }),
    ).toBeTruthy();
  });

  it('offers no tracking button while tracking is running', async () => {
    await renderSection({ phase: 'active', tripId: 't' });
    expect(
      screen.queryByRole('button', { name: 'Enable tracking' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Check trip status' }),
    ).toBeNull();
  });

  it.each<Partial<TrackingProjection>>([
    { completionUnknown: true, tripId: 't' },
    { phase: 'failed', problem: 'multiple_active_trips' },
    { phase: 'reconciling', problem: 'lookup_failed' },
  ])('offers a status re-check for %p', async (over) => {
    const handlers = await renderSection(over);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Check trip status' }),
    );
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables its buttons while an operation is running', async () => {
    const handlers = await renderSection({
      permission: 'none',
      problem: 'lookup_failed',
      droppedCount: 2,
      busy: true,
    });

    for (const name of [
      'Enable tracking',
      'Check trip status',
      'I understand the gap',
    ]) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      await fireEvent.press(button);
    }
    expect(handlers.onEnableTracking).not.toHaveBeenCalled();
    expect(handlers.onRetry).not.toHaveBeenCalled();
    expect(handlers.onAcknowledgeGap).not.toHaveBeenCalled();
  });
});

describe('what never reaches the screen', () => {
  it('shows a fixed native code and no platform text', async () => {
    await renderSection({
      phase: 'unavailable',
      nativeErrorCode: 'location_play_services_unavailable',
      problem: 'tracking_unavailable',
    });
    const text = renderedText();

    // The code is from the frozen vocabulary, which is diagnosable without
    // being a stack trace or a vendor message.
    expect(text).toMatch(/location_play_services_unavailable/);
    expect(text).not.toMatch(/Exception|android\.|\bat [A-Za-z]+\./);
  });

  it('omits the code line entirely when there is none', async () => {
    await renderSection({ phase: 'active', tripId: 't' });
    expect(renderedText()).not.toMatch(/Tracking code/);
  });

  it('prints no coordinate, instant, sample id or trip id', async () => {
    await renderSection({
      phase: 'active',
      tripId: '019a0000-0000-7000-8000-0000000000aa',
      pendingCount: 12,
      droppedCount: 3,
      nativeErrorCode: 'location_queue_error',
      drainOutcome: {
        kind: 'progress',
        submittedCount: 12,
        deletedCount: 12,
        moreLikely: false,
      },
    });
    const text = renderedText();

    // The projection carries a trip id; the section is not allowed to show it,
    // and has no access to a coordinate or an instant at all.
    expect(text).not.toContain('019a0000-0000-7000-8000-0000000000aa');
    expect(text).not.toMatch(/-?\d{1,3}\.\d{3,}/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});
