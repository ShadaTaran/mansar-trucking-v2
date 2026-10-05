import { PermissionsAndroid, Platform } from 'react-native';

/**
 * The one place this app asks Android for location permission.
 *
 * It is a boundary, not a policy: it prompts and returns nothing. What the app
 * may then do is decided from `native.getStatus(...)`, because the dialog
 * result and the permission the system actually holds are different facts — a
 * user can change a permission from Settings while the app is backgrounded,
 * and on Android 12+ a request for precise location can be answered with
 * approximate. Returning a verdict from here would invite callers to trust the
 * weaker of the two sources.
 *
 * Coarse and fine are requested **together**. Android 12+ ignores a fine-only
 * request, and asking for the pair is what lets the user grant approximate
 * deliberately rather than having the request dropped.
 *
 * `ACCESS_BACKGROUND_LOCATION` is never requested. Capture runs in a
 * foreground service created from a visible activity, which the platform
 * treats as foreground location for as long as it lives, so background
 * location would buy nothing and would add a second prompt and a Play Console
 * declaration.
 */

/** The pair that must be requested in one call. */
export const LOCATION_PERMISSIONS = [
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
] as const;

/** Runtime-requestable only from Android 13; a no-op below it. */
export const NOTIFICATION_PERMISSION = 'android.permission.POST_NOTIFICATIONS';
export const NOTIFICATION_PERMISSION_MIN_API = 33;

/**
 * The platform surface this boundary needs, injected so a test can record what
 * was asked for without a device.
 */
export interface PermissionHost {
  readonly os: string;
  /** Android API level; irrelevant on other platforms. */
  readonly apiLevel: number;
  request(permission: string): Promise<string>;
  requestMultiple(
    permissions: readonly string[],
  ): Promise<Record<string, string>>;
}

export interface LocationPermissionBoundary {
  /**
   * Prompts for coarse and fine location together.
   *
   * Resolves whatever the user chose, including a denial: the caller's next
   * step is always to re-read the native status, never to branch on a result
   * from here.
   */
  requestLocationPermission(): Promise<void>;
  /**
   * Prompts for the notification permission where the platform has one.
   *
   * Denial is not a tracking failure. The foreground service still starts; the
   * driver simply cannot see its notice, which the UI discloses.
   */
  requestNotificationPermission(): Promise<void>;
}

const platformHost: PermissionHost = {
  os: Platform.OS,
  apiLevel: typeof Platform.Version === 'number' ? Platform.Version : 0,
  request: (permission) =>
    PermissionsAndroid.request(
      permission as Parameters<typeof PermissionsAndroid.request>[0],
    ),
  requestMultiple: (permissions) =>
    PermissionsAndroid.requestMultiple(
      permissions as unknown as Parameters<
        typeof PermissionsAndroid.requestMultiple
      >[0],
    ),
};

export function createLocationPermissions(
  host: PermissionHost = platformHost,
): LocationPermissionBoundary {
  return {
    requestLocationPermission: async () => {
      if (host.os !== 'android') {
        return;
      }
      try {
        // The answer is deliberately discarded. A thrown prompt is also not an
        // error worth propagating: the status read that follows is what
        // decides, and it reports a denial the same way whether the dialog
        // failed or the user declined.
        await host.requestMultiple(LOCATION_PERMISSIONS);
      } catch {
        // Intentionally ignored; see above.
      }
    },

    requestNotificationPermission: async () => {
      if (
        host.os !== 'android' ||
        host.apiLevel < NOTIFICATION_PERMISSION_MIN_API
      ) {
        return;
      }
      try {
        await host.request(NOTIFICATION_PERMISSION);
      } catch {
        // Intentionally ignored: a missing notice never blocks capture.
      }
    },
  };
}
