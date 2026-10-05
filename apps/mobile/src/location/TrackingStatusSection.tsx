import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { DrainOutcome } from './location-drain';
import type { TrackingProjection } from './trip-location-orchestrator';

/**
 * What the driver is told about location tracking.
 *
 * Presentation only: it holds no API, no drain and no native module, and it
 * decides nothing about the lifecycle — it renders a projection and calls back
 * when the driver asks for something. Everything it may show is a state, never
 * a measurement: no coordinate, no sample id, no instant, no platform
 * exception text and no token. A driver learns *whether* their trip is being
 * recorded and what to do when it is not, which is what they are owed, and
 * nothing about what was recorded.
 */

interface Props {
  readonly state: TrackingProjection;
  /** Re-run reconciliation, or resolve an unknown completion. */
  readonly onRetry: () => void;
  /** Prompt for permission and try to establish capture again. */
  readonly onEnableTracking: () => void;
  /** The explicit acknowledgement of a coverage gap. */
  readonly onAcknowledgeGap: () => void;
}

/** The headline, derived from the phase and the completion question. */
function headline(state: TrackingProjection): string {
  if (state.completionUnknown) {
    return 'Completion not confirmed — tracking paused';
  }
  switch (state.phase) {
    case 'initializing':
    case 'reconciling':
      return 'Checking your trip status…';
    case 'active':
      return 'Tracking this trip';
    case 'paused':
      return 'Tracking paused';
    case 'inactive':
      return 'Not tracking — no trip in progress';
    case 'unavailable':
      return 'Tracking unavailable';
    case 'failed':
      // Deliberately neutral about the native session. Failing closed can
      // mean a paused session rather than a stopped one, and claiming
      // "stopped" would be a statement this app cannot make here.
      return 'Tracking needs attention';
  }
}

/** Why tracking cannot run, in the order a driver can act on. */
function blockers(state: TrackingProjection): string[] {
  const lines: string[] = [];
  if (state.permission === 'none') {
    lines.push('Location permission is required to record this trip.');
  } else if (state.permission === 'approximate') {
    // Deliberately not a promise about accuracy: the native filter judges
    // every fix on the accuracy the device reported, not on the permission.
    lines.push(
      'Approximate location only — coverage may be sparse while this is set.',
    );
  }
  if (!state.locationServicesEnabled) {
    lines.push('Location services are switched off on this device.');
  }
  if (!state.playServicesAvailable) {
    lines.push('Google Play Services is unavailable, so tracking cannot run.');
  }
  if (!state.notificationsEnabled) {
    // A warning, never a blocker: the service still runs.
    lines.push(
      'Notifications are off, so the tracking notice stays hidden. Tracking still runs.',
    );
  }
  if (state.problem === 'multiple_active_trips') {
    lines.push(
      'More than one trip is in progress for your account, so no trip is being recorded.',
    );
  }
  if (state.problem === 'lookup_failed') {
    lines.push('Your trip status could not be checked. Try again.');
  }
  if (state.problem === 'tracking_unavailable') {
    lines.push('Tracking could not be started on this device.');
  }
  return lines;
}

/** The upload state, as a sentence a driver can act on or ignore. */
function uploadLine(outcome: DrainOutcome | null): string | null {
  if (outcome === null) {
    return null;
  }
  switch (outcome.kind) {
    case 'empty':
      return 'All recorded positions have been uploaded.';
    case 'progress':
      return 'Uploading recorded positions.';
    case 'retryable':
      return 'Upload will retry automatically.';
    case 'blocked-auth':
      return 'Upload needs you to sign in again.';
    case 'blocked-protocol':
      return 'Upload was refused by the server. Positions are kept.';
    case 'blocked-reconcile':
      return 'Upload is waiting on this trip being checked again.';
    case 'blocked-forbidden':
      return 'Upload is not permitted for this account. Positions are kept.';
    case 'blocked-state':
      return 'Upload is paused until this trip can accept positions.';
    case 'queue-error':
      return 'Recorded positions could not be read on this device.';
  }
}

export function TrackingStatusSection({
  state,
  onRetry,
  onEnableTracking,
  onAcknowledgeGap,
}: Props) {
  const lines = blockers(state);
  const upload = uploadLine(state.drainOutcome);
  const canEnable =
    state.permission === 'none' ||
    state.phase === 'unavailable' ||
    state.problem === 'tracking_unavailable';
  const canRetry =
    state.completionUnknown ||
    state.phase === 'failed' ||
    state.problem === 'lookup_failed' ||
    state.problem === 'multiple_active_trips';

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        Trip tracking
      </Text>
      <Text style={styles.status}>{headline(state)}</Text>

      {lines.map((line) => (
        <Text key={line} style={styles.line}>
          {line}
        </Text>
      ))}

      {state.pendingCount > 0 ? (
        <Text style={styles.line}>
          {state.pendingCount} recorded position
          {state.pendingCount === 1 ? '' : 's'} waiting to upload.
        </Text>
      ) : null}

      {upload === null ? null : <Text style={styles.line}>{upload}</Text>}

      {state.nativeErrorCode === null ? null : (
        <Text style={styles.line}>Tracking code: {state.nativeErrorCode}</Text>
      )}

      {state.droppedCount > 0 ? (
        <View style={styles.gap}>
          {/*
            Owner-scoped, not trip-scoped: the native queue counts what it had
            to drop for this login, with no record of which journey each lost
            observation belonged to. Naming the trip on screen would tell the
            driver something nobody knows.
          */}
          <Text style={styles.line}>
            {state.droppedCount} position
            {state.droppedCount === 1 ? '' : 's'} could not be stored, so your
            recorded location history has a gap.
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={state.busy}
            onPress={onAcknowledgeGap}
            style={[styles.button, state.busy && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>I understand the gap</Text>
          </Pressable>
        </View>
      ) : null}

      {canEnable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: state.busy, disabled: state.busy }}
          disabled={state.busy}
          onPress={onEnableTracking}
          style={[styles.button, state.busy && styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>Enable tracking</Text>
        </Pressable>
      ) : null}

      {canRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: state.busy, disabled: state.busy }}
          disabled={state.busy}
          onPress={onRetry}
          style={[styles.button, state.busy && styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>Check trip status</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderColor: '#d0d0d0',
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 16,
    padding: 12,
  },
  heading: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  status: {
    fontSize: 15,
    marginBottom: 4,
  },
  line: {
    fontSize: 13,
    marginTop: 2,
  },
  gap: {
    marginTop: 8,
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#1f6feb',
    borderRadius: 6,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '600',
  },
});
