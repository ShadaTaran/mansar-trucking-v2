# @mansar/mobile

Driver mobile application for the Mansar Trucking Management System v2, built
with React Native (Android only for the MVP; the generated iOS project was
removed because it cannot be built or verified in this environment).

Implemented so far: driver authentication (sign in, session restore after
restart, sign out) against the API. Trip screens, location sharing and the
offline queue arrive in later stages.

Native identity: project `MansarDriver`, display name "Mansar Driver",
Android application id `com.mansar.driver`.

## Commands

Run from the repository root with `-w @mansar/mobile`, or from this directory.

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `npm run start`     | Start Metro (port `8081`)                                           |
| `npm run android`   | Build the debug app and install it on the connected device/emulator |
| `npm run typecheck` | `tsc --noEmit`                                                      |
| `npm run lint`      | ESLint (root flat config)                                           |
| `npm run test`      | Jest + React Native Testing Library                                 |

Scripts that bundle, build or test the app (`start`, `android`, `typecheck`,
`test`, `test:watch`) first run `build:deps`, which builds the
`@mansar/api-client` workspace package (and, through its project reference,
`@mansar/types`) that this app consumes. Installation never generates that
output.

There is intentionally no generic `build` script: the Android native build is
an explicit step (`npm run android` or Gradle), not part of the root `build`.

Debug builds use the Android Gradle Plugin's standard debug signing
(`~/.android/debug.keystore`, generated automatically); no keystore is stored
in the repository. Release signing is configured in a later stage.

## Authentication

The app talks to the API directly with bearer tokens (`client: "MOBILE"`);
the API remains the only authentication authority
([docs/authentication.md §11](../../docs/authentication.md),
[ADR 0008](../../docs/adr/0008-mobile-authentication.md)).

- `src/auth/auth-secret-store.ts` — the only module touching
  `react-native-keychain`; stores the refresh token (and nothing else) under
  the service `com.mansar.driver.auth.refresh`, Android Keystore-backed
  AES-GCM, no biometric prompt.
- `src/auth/session-manager.ts` — state machine (`bootstrapping`,
  `unauthenticated`, `authenticated`, `bootstrap_error`), single-flight
  refresh, DRIVER-only enforcement, logout / logout-all. The access token is
  memory-only and never part of the published state.
- `src/auth/authenticated-fetch.ts` — bearer requests with one automatic
  refresh + retry on 401.
- `src/auth/auth-context.tsx`, `src/screens/*` — React wiring and the
  minimal sign-in, loading, retry and signed-in placeholder screens.

AsyncStorage must never hold credentials; an ESLint rule scoped to
`src/auth/**` rejects `@react-native-async-storage/async-storage`.

`react-native-keychain` is linked through React Native autolinking; no manual
registration in `MainApplication.kt`.

## API endpoint per build variant

The API base URL is build-time configuration (never a secret, never
user-editable). Each Android build type fixes `BuildConfig.MANSAR_API_BASE_URL`
in `android/app/build.gradle`; the small `MansarConfig` native module
(`android/app/src/main/java/com/mansar/driver/config/`, spec
`src/specs/NativeMansarConfig.ts`) hands it to JavaScript, and
`src/config/api.ts` validates it:

| Variant   | Endpoint                                    | App id                      | Cleartext | JS bundle      | Signing             |
| --------- | ------------------------------------------- | --------------------------- | --------- | -------------- | ------------------- |
| `debug`   | `http://10.0.2.2:3001`                      | `com.mansar.driver`         | allowed   | Metro (dev)    | automatic debug key |
| `staging` | `https://mansar-api-staging.up.railway.app` | `com.mansar.driver.staging` | disabled  | bundled in APK | automatic debug key |
| `release` | _empty_ → fails closed                      | `com.mansar.driver`         | disabled  | bundled in APK | none (unsigned)     |

The resolver accepts an HTTPS origin, or plain HTTP only for the local
development hosts (`10.0.2.2`, `127.0.0.1`, `localhost`); anything else —
empty, malformed, a path/query/fragment/credentials, plain HTTP to a public
host — resolves to nothing and the app renders "This build has no API
endpoint configured." without creating a session, API client or network
request. There is no production endpoint yet, so `release` fails closed on
purpose; it also stays unsigned until the release stage.

Debug and staging install side by side (different application ids). Android
sandboxes Keystore/Keychain storage per application, so the fixed Keychain
service `com.mansar.driver.auth.refresh` needs no change and the two installs
never share a refresh token.

### Local debug (unchanged)

`npm run android -w @mansar/mobile` builds and installs the debug app; the
Android emulator reaches the host's API at `http://10.0.2.2:3001`
(`npm run start:dev -w @mansar/api`). For a physical device over USB, forward
the port and use `http://127.0.0.1:3001` in the debug `buildConfigField`:

```bash
adb reverse tcp:3001 tcp:3001
```

On an Android 17 emulator the debug app must hold the local-network runtime
permission (`ACCESS_LOCAL_NETWORK`, prompted by React Native's dev tooling as
"nearby devices") to reach `10.0.2.2` at all; declining it makes both Metro
and the API unreachable from the app. Accept the prompt, or grant it once:

```bash
adb shell pm grant com.mansar.driver android.permission.ACCESS_LOCAL_NETWORK
```

### Staging

```bash
npm run android:staging -w @mansar/mobile
```

runs `react-native run-android --mode staging --appIdSuffix staging
--no-packager`: builds the `staging` variant (its Hermes bundle is created
by Gradle, so no Metro is needed at runtime), installs
`com.mansar.driver.staging` and launches it against the staging API over
HTTPS. The native APK alone:

```bash
cd apps/mobile/android && .\gradlew.bat assembleStaging
```

→ `android/app/build/outputs/apk/staging/app-staging.apk` (git-ignored;
never commit build output). The public Railway host needs no local-network
permission.

Note for existing checkouts: the app's own codegen spec (`src/specs/`) is
compiled into `libappmodules.so` from a CMake source glob. A native build
configured before the spec existed keeps a stale graph and the module is
then missing at runtime ("'MansarConfig' could not be found"). Run
`.\gradlew.bat clean` (or delete `android/app/.cxx`) once after pulling
this change; fresh clones and CI are unaffected.

## Testing

`npm test -w @mansar/mobile` runs Jest with `react-native-keychain` replaced
by the in-memory fake in `__mocks__/react-native-keychain.ts`; no Android
Keystore is involved. Fixtures use obviously synthetic accounts
(`driver@example.test`) and token values.

A native build (`cd android && .\gradlew.bat assembleDebug` on Windows,
`./gradlew assembleDebug` elsewhere) proves that the Keychain module
autolinks and compiles; build output under `android/` is git-ignored.
