/**
 * Jest stand-in for the TripLocation native module.
 *
 * The foreground service, the fused provider and the SQLite queue cannot run
 * under Jest, so tests drive this fake instead: they set the status it should
 * report, the rows it should hand back, or the fixed code it should reject
 * with, then assert what the Stage 8C.2 JavaScript makes of it.
 *
 * Deliberately **no behaviour of its own** — no capture, no filtering, no
 * queue, no network. It records the calls it received and returns what the
 * test told it to. Anything the JS tracker and drainer are responsible for is
 * therefore testable without a single line of Android code.
 */

export type MockPermission = 'none' | 'approximate' | 'precise';

export interface MockStatus {
  running: boolean;
  paused: boolean;
  ownerUserId: string | null;
  tripId: string | null;
  permission: string;
  locationServicesEnabled: boolean;
  playServicesAvailable: boolean;
  notificationsEnabled: boolean;
  pendingCount: number;
  droppedCount: number;
  lastErrorCode: string | null;
}

export interface MockSample {
  sampleId: string;
  tripId: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  recordedAt: string;
  attempts: number;
}

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

const STOPPED: MockStatus = {
  running: false,
  paused: false,
  ownerUserId: null,
  tripId: null,
  permission: 'precise',
  locationServicesEnabled: true,
  playServicesAvailable: true,
  notificationsEnabled: true,
  pendingCount: 0,
  droppedCount: 0,
  lastErrorCode: null,
};

export const __tripLocationFake = {
  /** Every call this fake received, in order. */
  calls: [] as Call[],
  /** What `getStatus`, `startTracking` and `stopTracking` resolve with. */
  status: { ...STOPPED } as MockStatus,
  /** What `readQueuedSamples` resolves with, before the limit is applied. */
  samples: [] as MockSample[],
  /** Methods queued to reject, by name, with a fixed code. */
  rejections: {} as Record<string, unknown>,
  /** Rows the next mutation should report as affected; null = count the ids. */
  affected: null as number | null,

  /** Make the next call to `method` reject. */
  rejectNext(method: string, error: unknown): void {
    this.rejections[method] = error;
  },
  /** Replace the reported status. */
  setStatus(status: Partial<MockStatus>): void {
    this.status = { ...this.status, ...status };
  },
  /** Replace the rows `readQueuedSamples` hands back. */
  setSamples(samples: MockSample[]): void {
    this.samples = samples;
  },
  /** Calls recorded for one method name. */
  callsTo(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  },
  reset(): void {
    this.calls = [];
    this.status = { ...STOPPED };
    this.samples = [];
    this.rejections = {};
    this.affected = null;
  },
};

function record(method: string, ...args: unknown[]): void {
  __tripLocationFake.calls.push({ method, args });
  const error = __tripLocationFake.rejections[method];
  if (error !== undefined) {
    delete __tripLocationFake.rejections[method];
    throw error;
  }
}

const NativeTripLocation = {
  getStatus: async (ownerUserId: string) => {
    record('getStatus', ownerUserId);
    return __tripLocationFake.status;
  },
  startTracking: async (ownerUserId: string, tripId: string) => {
    record('startTracking', ownerUserId, tripId);
    return __tripLocationFake.status;
  },
  stopTracking: async () => {
    record('stopTracking');
    return __tripLocationFake.status;
  },
  // Deliberately no pause/resume state machine here: the fake records the
  // call and returns whatever status the test set, so a test asserts what the
  // JavaScript makes of a status rather than what the fake would.
  pauseTracking: async (ownerUserId: string, tripId: string) => {
    record('pauseTracking', ownerUserId, tripId);
    return __tripLocationFake.status;
  },
  resumeTracking: async (ownerUserId: string, tripId: string) => {
    record('resumeTracking', ownerUserId, tripId);
    return __tripLocationFake.status;
  },
  readQueuedSamples: async (ownerUserId: string, limit: number) => {
    record('readQueuedSamples', ownerUserId, limit);
    // The real module never returns more than requested; the fake matches so
    // a test cannot pass against behaviour the device would not produce.
    return { samples: __tripLocationFake.samples.slice(0, limit) };
  },
  deleteQueuedSamples: async (ownerUserId: string, sampleIds: string[]) => {
    record('deleteQueuedSamples', ownerUserId, sampleIds);
    return { affected: __tripLocationFake.affected ?? sampleIds.length };
  },
  incrementAttempts: async (ownerUserId: string, sampleIds: string[]) => {
    record('incrementAttempts', ownerUserId, sampleIds);
    return { affected: __tripLocationFake.affected ?? sampleIds.length };
  },
  acknowledgeDroppedSamples: async (ownerUserId: string) => {
    record('acknowledgeDroppedSamples', ownerUserId);
    return { affected: __tripLocationFake.affected ?? 0 };
  },
};

export default NativeTripLocation;
