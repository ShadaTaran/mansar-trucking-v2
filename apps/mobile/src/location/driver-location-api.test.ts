import { ApiError } from '@mansar/api-client';

import { NotAuthenticatedError } from '../auth/authenticated-fetch';
import {
  createDriverLocationApi,
  type IngestibleLocationSample,
  LocationBatchError,
  MAX_INGEST_SAMPLES,
  parseLocationIngestionResult,
} from './driver-location-api';

/**
 * The ingestion binding, on Jest.
 *
 * Two things are being proved. First, that exactly five fields per sample
 * travel and the trip id stays in the URL — the server's schema is strict, so
 * a stray key is a 400, and a local-only identity in a request body is a
 * privacy defect rather than a formatting one. Second, that an answer which
 * is not the documented shape is refused instead of being trusted, because
 * the drain deletes queued rows on the strength of it.
 *
 * No real network: the transport is a recording function. No credential
 * either — the binding is handed an `AuthenticatedFetch` and never sees a
 * token, which is also why the refresh-and-retry behaviour is asserted here
 * only as an absence: it must live in `authenticated-fetch.ts`, which owns and
 * tests it, and not be reimplemented in this module.
 */

const BASE_URL = 'https://api.example.test';
const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';

const SAMPLE: IngestibleLocationSample = {
  sampleId: '019a1111-0000-7000-8000-000000000001',
  latitude: 14.599512,
  longitude: 120.984222,
  accuracy: 8.5,
  recordedAt: '2026-10-01T04:05:06.789Z',
};

const sample = (index: number): IngestibleLocationSample => ({
  ...SAMPLE,
  sampleId: `019a1111-0000-7000-8000-${String(index).padStart(12, '0')}`,
});

const accepted = (samples: readonly IngestibleLocationSample[]) => ({
  results: samples.map((one) => ({
    sampleId: one.sampleId,
    outcome: 'accepted',
  })),
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  /** Undefined when the caller passed no deadline. */
  readonly signal: { readonly aborted: boolean } | undefined;
  /** Whether the key was present at all. */
  readonly hasSignalKey: boolean;
}

const json = (status: number, body: unknown) => ({
  status,
  text: () => Promise.resolve(JSON.stringify(body)),
});

/** Records what the transport was asked to send, and answers with `respond`. */
function harness(respond: (url: string) => ReturnType<typeof json>) {
  const calls: Call[] = [];
  const api = createDriverLocationApi(BASE_URL, (url, init = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? init.body : undefined,
      signal: init.signal,
      hasSignalKey: 'signal' in init,
    });
    return Promise.resolve(respond(url) as unknown as Response);
  });
  return { api, calls };
}

const sentBody = (call: Call): { samples: Record<string, unknown>[] } =>
  JSON.parse(call.body ?? 'null') as { samples: Record<string, unknown>[] };

describe('ingestion request', () => {
  it('posts to the trip-scoped location-samples route', async () => {
    const { api, calls } = harness(() => json(200, accepted([SAMPLE])));
    await api.ingest(TRIP_ID, [SAMPLE]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${BASE_URL}/driver/trips/${TRIP_ID}/location-samples`,
    );
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
  });

  it('percent-encodes the trip id in the path', async () => {
    const { api, calls } = harness(() => json(200, accepted([SAMPLE])));
    await api.ingest('trip/../other', [SAMPLE]);
    expect(calls[0]!.url).toBe(
      `${BASE_URL}/driver/trips/trip%2F..%2Fother/location-samples`,
    );
  });

  it('sends exactly the five documented fields per sample', async () => {
    const { api, calls } = harness(() => json(200, accepted([SAMPLE])));
    await api.ingest(TRIP_ID, [SAMPLE]);

    const body = sentBody(calls[0]!);
    expect(Object.keys(body)).toEqual(['samples']);
    expect(Object.keys(body.samples[0]!).sort()).toEqual([
      'accuracy',
      'latitude',
      'longitude',
      'recordedAt',
      'sampleId',
    ]);
    expect(body.samples[0]).toEqual({
      sampleId: SAMPLE.sampleId,
      latitude: SAMPLE.latitude,
      longitude: SAMPLE.longitude,
      accuracy: SAMPLE.accuracy,
      recordedAt: SAMPLE.recordedAt,
    });
  });

  it('sends a null accuracy as null', async () => {
    const { api, calls } = harness(() =>
      json(200, accepted([{ ...SAMPLE, accuracy: null }])),
    );
    await api.ingest(TRIP_ID, [{ ...SAMPLE, accuracy: null }]);
    expect(sentBody(calls[0]!).samples[0]!.accuracy).toBeNull();
  });

  it('never sends a trip, attempt, owner, driver, vehicle, device or row id', async () => {
    const { api, calls } = harness(() => json(200, accepted([SAMPLE])));
    // A caller handing over a queued row verbatim must not leak its extra
    // fields: the body is rebuilt, not spread.
    const queuedRow = {
      ...SAMPLE,
      tripId: TRIP_ID,
      attempts: 3,
      ownerUserId: 'owner-1',
      driverId: 'driver-1',
      vehicleId: 'vehicle-1',
      userId: 'user-1',
      deviceId: 'device-1',
      receivedAt: '2026-10-01T04:06:00.000Z',
      id: 'row-1',
    } as IngestibleLocationSample;
    await api.ingest(TRIP_ID, [queuedRow]);

    const raw = calls[0]!.body ?? '';
    for (const field of [
      'tripId',
      'attempts',
      'ownerUserId',
      'driverId',
      'vehicleId',
      'userId',
      'deviceId',
      'receivedAt',
    ]) {
      expect(raw).not.toContain(field);
    }
    expect(Object.keys(sentBody(calls[0]!).samples[0]!)).toHaveLength(5);
  });

  it('accepts a single sample and a full hundred', async () => {
    const one = [sample(1)];
    const full = Array.from({ length: MAX_INGEST_SAMPLES }, (_, i) =>
      sample(i + 1),
    );
    const single = harness(() => json(200, accepted(one)));
    await expect(single.api.ingest(TRIP_ID, one)).resolves.toHaveLength(1);

    const batch = harness(() => json(200, accepted(full)));
    await expect(batch.api.ingest(TRIP_ID, full)).resolves.toHaveLength(100);
    expect(sentBody(batch.calls[0]!).samples).toHaveLength(100);
  });
});

describe('batches refused before transport', () => {
  const refusals: ReadonlyArray<
    readonly [string, readonly IngestibleLocationSample[], string]
  > = [
    ['an empty batch', [], 'empty_batch'],
    [
      '101 samples',
      Array.from({ length: 101 }, (_, i) => sample(i + 1)),
      'batch_too_large',
    ],
    ['a duplicated sample id', [SAMPLE, SAMPLE], 'duplicate_sample_id'],
    ['a blank sample id', [{ ...SAMPLE, sampleId: '   ' }], 'invalid_sample'],
    [
      'an out-of-range latitude',
      [{ ...SAMPLE, latitude: 90.5 }],
      'invalid_sample',
    ],
    [
      'an out-of-range longitude',
      [{ ...SAMPLE, longitude: -180.5 }],
      'invalid_sample',
    ],
    [
      'a non-finite coordinate',
      [{ ...SAMPLE, latitude: Number.NaN }],
      'invalid_sample',
    ],
    ['a negative accuracy', [{ ...SAMPLE, accuracy: -1 }], 'invalid_sample'],
    [
      'a non-canonical instant',
      [{ ...SAMPLE, recordedAt: '2026-10-01T04:05:06Z' }],
      'invalid_sample',
    ],
    [
      'an impossible instant',
      [{ ...SAMPLE, recordedAt: '2026-02-30T04:05:06.789Z' }],
      'invalid_sample',
    ],
  ];

  it.each(refusals)(
    'refuses %s and sends nothing',
    async (_label, samples, problem) => {
      const { api, calls } = harness(() => json(200, { results: [] }));
      const failure = (await api
        .ingest(TRIP_ID, samples)
        .catch((error: unknown) => error)) as LocationBatchError;
      expect(failure).toBeInstanceOf(LocationBatchError);
      expect(failure.problem).toBe(problem);
      expect(calls).toHaveLength(0);
    },
  );

  it('refuses a blank trip id and sends nothing', async () => {
    const { api, calls } = harness(() => json(200, accepted([SAMPLE])));
    await expect(api.ingest('   ', [SAMPLE])).rejects.toMatchObject({
      problem: 'invalid_trip_id',
    });
    expect(calls).toHaveLength(0);
  });

  it('does not split an oversized batch', async () => {
    const { api, calls } = harness(() => json(200, { results: [] }));
    await api
      .ingest(
        TRIP_ID,
        Array.from({ length: 150 }, (_, i) => sample(i + 1)),
      )
      .catch(() => undefined);
    // Not two requests of 100 and 50; none at all.
    expect(calls).toHaveLength(0);
  });
});

describe('response parsing', () => {
  const resultsOf = async (results: unknown) => {
    const { api } = harness(() => json(200, { results }));
    return api.ingest(TRIP_ID, [SAMPLE]);
  };

  it('parses the four permanent outcomes', async () => {
    await expect(
      resultsOf([{ sampleId: SAMPLE.sampleId, outcome: 'accepted' }]),
    ).resolves.toEqual([{ sampleId: SAMPLE.sampleId, outcome: 'accepted' }]);
    await expect(
      resultsOf([{ sampleId: SAMPLE.sampleId, outcome: 'duplicate' }]),
    ).resolves.toEqual([{ sampleId: SAMPLE.sampleId, outcome: 'duplicate' }]);
    await expect(
      resultsOf([
        {
          sampleId: SAMPLE.sampleId,
          outcome: 'rejected',
          reason: 'out_of_window',
        },
      ]),
    ).resolves.toEqual([
      {
        sampleId: SAMPLE.sampleId,
        outcome: 'rejected',
        reason: 'out_of_window',
      },
    ]);
    await expect(
      resultsOf([
        {
          sampleId: SAMPLE.sampleId,
          outcome: 'rejected',
          reason: 'sample_id_conflict',
        },
      ]),
    ).resolves.toEqual([
      {
        sampleId: SAMPLE.sampleId,
        outcome: 'rejected',
        reason: 'sample_id_conflict',
      },
    ]);
  });

  it.each([
    [
      'accepted with an out_of_window reason',
      { sampleId: 'a', outcome: 'accepted', reason: 'out_of_window' },
    ],
    [
      'accepted with a sample_id_conflict reason',
      { sampleId: 'a', outcome: 'accepted', reason: 'sample_id_conflict' },
    ],
    [
      'duplicate with a sample_id_conflict reason',
      { sampleId: 'a', outcome: 'duplicate', reason: 'sample_id_conflict' },
    ],
    [
      'duplicate with an out_of_window reason',
      { sampleId: 'a', outcome: 'duplicate', reason: 'out_of_window' },
    ],
    [
      'accepted with an unrecognised reason',
      { sampleId: 'a', outcome: 'accepted', reason: 'whatever' },
    ],
    [
      'accepted with a null reason',
      { sampleId: 'a', outcome: 'accepted', reason: null },
    ],
  ])('refuses a contradictory result: %s', (_label, result) => {
    // Stored *and* refused cannot both be true. The contradiction is not
    // stripped, because the half that was kept would decide whether a queued
    // row is deleted.
    expect(parseLocationIngestionResult({ results: [result] })).toBeNull();
  });

  it('still accepts a clean accepted or duplicate result', () => {
    expect(
      parseLocationIngestionResult({
        results: [
          { sampleId: 'a', outcome: 'accepted' },
          { sampleId: 'b', outcome: 'duplicate' },
        ],
      }),
    ).toEqual({
      results: [
        { sampleId: 'a', outcome: 'accepted' },
        { sampleId: 'b', outcome: 'duplicate' },
      ],
    });
  });

  it.each([
    ['an unknown outcome', [{ sampleId: 'a', outcome: 'queued' }]],
    ['a retryable-looking outcome', [{ sampleId: 'a', outcome: 'retry' }]],
    [
      'an unknown rejection reason',
      [{ sampleId: 'a', outcome: 'rejected', reason: 'rate_limited' }],
    ],
    ['a rejection with no reason', [{ sampleId: 'a', outcome: 'rejected' }]],
    [
      'an accepted result that also names a reason',
      [{ sampleId: 'a', outcome: 'accepted', reason: 'out_of_window' }],
    ],
    [
      'a duplicate result that also names a reason',
      [{ sampleId: 'a', outcome: 'duplicate', reason: 'sample_id_conflict' }],
    ],
    ['a missing sample id', [{ outcome: 'accepted' }]],
    ['a blank sample id', [{ sampleId: '', outcome: 'accepted' }]],
    ['a non-string sample id', [{ sampleId: 7, outcome: 'accepted' }]],
    ['a non-object result', ['accepted']],
    ['a null result', [null]],
  ])('refuses %s', async (_label, results) => {
    const failure = (await resultsOf(results).catch(
      (error: unknown) => error,
    )) as ApiError;
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.kind).toBe('invalid_response');
  });

  it.each([
    ['a missing results key', {}],
    ['a null results value', { results: null }],
    ['a non-array results value', { results: { 0: 'accepted' } }],
    ['an array at the top level', []],
    ['a string body', 'accepted'],
  ])('refuses %s', async (_label, body) => {
    const { api } = harness(() => json(200, body));
    await expect(api.ingest(TRIP_ID, [SAMPLE])).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('accepts an empty results array structurally', () => {
    // Shape-valid; it is the drain that requires one result per sample.
    expect(parseLocationIngestionResult({ results: [] })).toEqual({
      results: [],
    });
  });

  it('reports an HTTP failure as an ApiError carrying the code', async () => {
    const { api } = harness(() =>
      json(409, { statusCode: 409, message: 'trip_not_trackable' }),
    );
    const failure = (await api
      .ingest(TRIP_ID, [SAMPLE])
      .catch((error: unknown) => error)) as ApiError;
    expect(failure.kind).toBe('http');
    expect(failure.status).toBe(409);
    expect(failure.code).toBe('trip_not_trackable');
    expect(failure.message).not.toMatch(/statusCode|trip_not_trackable/);
  });

  it('reports a transport failure as a network ApiError', async () => {
    const api = createDriverLocationApi(BASE_URL, () =>
      Promise.reject(new Error('socket closed')),
    );
    const failure = (await api
      .ingest(TRIP_ID, [SAMPLE])
      .catch((error: unknown) => error)) as ApiError;
    expect(failure.kind).toBe('network');
    expect(failure.message).not.toMatch(/socket closed/);
  });

  it('propagates NotAuthenticatedError instead of a network error', async () => {
    const api = createDriverLocationApi(BASE_URL, () => {
      throw new NotAuthenticatedError();
    });
    // The drain must be able to tell "no session" from "server unreachable":
    // only one of them counts as an upload attempt.
    await expect(api.ingest(TRIP_ID, [SAMPLE])).rejects.toBeInstanceOf(
      NotAuthenticatedError,
    );
  });
});

describe('authentication stays with the injected transport', () => {
  it('adds no retry of its own to a 401', async () => {
    // `AuthenticatedFetch` owns refresh-and-single-retry and proves it in its
    // own tests. What has to be true *here* is that this binding adds nothing
    // to that: the transport it was given is called once, and whatever that
    // call answers is final. A retry appearing in this module would mean the
    // behaviour had been reimplemented rather than inherited.
    const transport = jest.fn(() =>
      Promise.resolve({
        status: 401,
        text: () => Promise.resolve('{"message":"unauthorized"}'),
      } as unknown as Response),
    );
    const api = createDriverLocationApi(BASE_URL, transport);

    const failure = (await api
      .ingest(TRIP_ID, [SAMPLE])
      .catch((error: unknown) => error)) as ApiError;
    expect(failure.kind).toBe('http');
    expect(failure.status).toBe(401);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('sends no Authorization header of its own', async () => {
    const { api, calls } = harness(() => json(200, accepted([SAMPLE])));
    await api.ingest(TRIP_ID, [SAMPLE]);
    // Exactly the two headers api-client sets. The bearer belongs to the
    // injected transport, and this module has no token to build one from.
    expect(Object.keys(calls[0]!.headers).sort()).toEqual([
      'accept',
      'content-type',
    ]);
    expect(calls[0]!.headers).not.toHaveProperty('authorization');
  });

  it('exposes no way to pass a credential in', () => {
    const api = createDriverLocationApi(BASE_URL, () =>
      Promise.resolve(json(200, { results: [] }) as unknown as Response),
    );
    // Three parameters: the trip, its samples, and an optional cancellation
    // handle. Still no credential — a signal carries no identity and names no
    // user — so a token cannot reach this layer even by accident.
    expect(api.ingest).toHaveLength(3);
    expect(Object.keys(api)).toEqual(['ingest']);
  });

  it('forwards an optional signal to the transport', async () => {
    const { api, calls } = harness(() => json(200, accepted([SAMPLE])));
    const controller = new AbortController();

    await api.ingest(TRIP_ID, [SAMPLE], controller.signal);

    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it('omits the signal entirely for a caller without one', async () => {
    const { api, calls } = harness(() => json(200, accepted([SAMPLE])));

    await api.ingest(TRIP_ID, [SAMPLE]);

    // Absent rather than undefined, so every existing caller's request is
    // byte-for-byte the one it sent before.
    expect(calls[0]!.hasSignalKey).toBe(false);
  });

  it('keeps the signal out of the URL, the headers and the body', async () => {
    const { api, calls } = harness(() => json(200, accepted([SAMPLE])));
    const controller = new AbortController();

    await api.ingest(TRIP_ID, [SAMPLE], controller.signal);

    const call = calls[0]!;
    expect(Object.keys(call.headers).sort()).toEqual([
      'accept',
      'content-type',
    ]);
    expect(call.url).not.toContain('signal');
    expect(Object.keys(sentBody(call))).toEqual(['samples']);
    expect(Object.keys(sentBody(call).samples[0]!).sort()).toEqual([
      'accuracy',
      'latitude',
      'longitude',
      'recordedAt',
      'sampleId',
    ]);
  });
});
