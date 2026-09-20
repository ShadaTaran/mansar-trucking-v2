/**
 * API base URL for the driver app. This is configuration, not a credential.
 *
 * Development configuration (the only one that exists at this stage; there
 * is no approved production URL yet): the API runs on the developer's host
 * on port 3001 and the app runs in the Android emulator, which reaches the
 * host through the special address 10.0.2.2. A physical device instead uses
 * `adb reverse tcp:3001 tcp:3001` and `http://127.0.0.1:3001`; see
 * apps/mobile/README.md. Plain HTTP is allowed in debug builds only
 * (`usesCleartextTraffic` is set by the React Native Gradle plugin).
 */
export const API_BASE_URL = 'http://10.0.2.2:3001';
