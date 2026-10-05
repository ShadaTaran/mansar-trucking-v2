import {
  createLocationPermissions,
  LOCATION_PERMISSIONS,
  NOTIFICATION_PERMISSION,
  NOTIFICATION_PERMISSION_MIN_API,
  type PermissionHost,
} from './location-permissions';

/**
 * What this app asks Android for, and nothing more.
 *
 * The three statements worth proving here are all about the *request*, not
 * about a verdict: coarse and fine go out together in one call, the
 * notification prompt exists only where the platform has one, and
 * `ACCESS_BACKGROUND_LOCATION` is never asked for at all. The boundary
 * deliberately returns no result, so there is no "granted" assertion to make —
 * what the app may do afterwards is read from native status, and a test that
 * asserted on a dialog answer would be asserting the wrong source.
 */

function createHost(over: Partial<PermissionHost> = {}) {
  const requested: string[] = [];
  const requestedMultiple: string[][] = [];
  const host: PermissionHost = {
    os: 'android',
    apiLevel: 36,
    request: async (permission) => {
      requested.push(permission);
      return 'granted';
    },
    requestMultiple: async (permissions) => {
      requestedMultiple.push([...permissions]);
      return Object.fromEntries(
        permissions.map((permission) => [permission, 'granted']),
      );
    },
    ...over,
  };
  return {
    host,
    requested,
    requestedMultiple,
    /** Every permission string this host was ever asked about. */
    all: () => [...requested, ...requestedMultiple.flat()],
  };
}

describe('location permission request', () => {
  it('asks for coarse and fine together in a single call', async () => {
    const h = createHost();
    await createLocationPermissions(h.host).requestLocationPermission();

    // Android 12+ drops a fine-only request; the pair is what lets the user
    // choose approximate deliberately.
    expect(h.requestedMultiple).toEqual([
      [
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
      ],
    ]);
    expect(h.requestedMultiple[0]).toEqual([...LOCATION_PERMISSIONS]);
    expect(h.requested).toEqual([]);
  });

  it('never requests background location', async () => {
    const h = createHost();
    const permissions = createLocationPermissions(h.host);
    await permissions.requestLocationPermission();
    await permissions.requestNotificationPermission();

    // Capture runs in a foreground service started from a visible activity,
    // so background location would buy nothing and would add a prompt and a
    // Play Console declaration.
    expect(h.all()).not.toContain(
      'android.permission.ACCESS_BACKGROUND_LOCATION',
    );
    expect(
      h.all().some((permission) => permission.includes('BACKGROUND')),
    ).toBe(false);
  });

  it('discards the dialog answer rather than returning it', async () => {
    const h = createHost({
      requestMultiple: async () => ({
        'android.permission.ACCESS_FINE_LOCATION': 'denied',
        'android.permission.ACCESS_COARSE_LOCATION': 'never_ask_again',
      }),
    });

    // A denial is not an error and not a return value: the status read that
    // follows is the only thing allowed to decide.
    await expect(
      createLocationPermissions(h.host).requestLocationPermission(),
    ).resolves.toBeUndefined();
  });

  it('swallows a failed prompt', async () => {
    const h = createHost({
      requestMultiple: async () => {
        throw new Error('activity unavailable');
      },
    });

    // The caller re-reads status either way, and status reports a missing
    // permission identically whether the dialog failed or was declined.
    await expect(
      createLocationPermissions(h.host).requestLocationPermission(),
    ).resolves.toBeUndefined();
  });

  it('asks nothing on a platform without these permissions', async () => {
    const h = createHost({ os: 'ios' });
    await createLocationPermissions(h.host).requestLocationPermission();
    expect(h.all()).toEqual([]);
  });
});

describe('notification permission request', () => {
  it('asks once, on its own, from Android 13', async () => {
    const h = createHost({ apiLevel: NOTIFICATION_PERMISSION_MIN_API });
    await createLocationPermissions(h.host).requestNotificationPermission();

    expect(h.requested).toEqual([NOTIFICATION_PERMISSION]);
    expect(h.requested).toEqual(['android.permission.POST_NOTIFICATIONS']);
    // Not bundled with the location pair: two separate prompts, each at the
    // moment it is relevant.
    expect(h.requestedMultiple).toEqual([]);
  });

  it('asks nothing below Android 13, where it is install-time', async () => {
    const h = createHost({ apiLevel: NOTIFICATION_PERMISSION_MIN_API - 1 });
    await createLocationPermissions(h.host).requestNotificationPermission();
    expect(h.all()).toEqual([]);
  });

  it('asks nothing on another platform', async () => {
    const h = createHost({ os: 'ios', apiLevel: 36 });
    await createLocationPermissions(h.host).requestNotificationPermission();
    expect(h.all()).toEqual([]);
  });

  it('swallows a failed prompt, because a missing notice blocks nothing', async () => {
    const h = createHost({
      request: async () => {
        throw new Error('no activity');
      },
    });
    await expect(
      createLocationPermissions(h.host).requestNotificationPermission(),
    ).resolves.toBeUndefined();
  });

  it('treats a denial as a warning, not a failure', async () => {
    const h = createHost({ request: async () => 'denied' });
    await expect(
      createLocationPermissions(h.host).requestNotificationPermission(),
    ).resolves.toBeUndefined();
  });
});

describe('the frozen permission vocabulary', () => {
  it('is exactly the two location strings, fine first', () => {
    expect(LOCATION_PERMISSIONS).toHaveLength(2);
    expect(LOCATION_PERMISSIONS[0]).toBe(
      'android.permission.ACCESS_FINE_LOCATION',
    );
    expect(LOCATION_PERMISSIONS[1]).toBe(
      'android.permission.ACCESS_COARSE_LOCATION',
    );
  });

  it('gates notifications on API 33', () => {
    expect(NOTIFICATION_PERMISSION_MIN_API).toBe(33);
  });
});
