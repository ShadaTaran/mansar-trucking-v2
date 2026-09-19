# @mansar/mobile

Driver mobile application for the Mansar Trucking Management System v2, built
with React Native (Android only for the MVP; the generated iOS project was
removed because it cannot be built or verified in this environment).

Scaffold stage only: the app renders a single development screen that proves
the workspace wiring. Trip screens, authentication, location sharing, and API
integration arrive in later stages.

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
`test`, `test:watch`) first run `build:deps`, which builds the `@mansar/types`
workspace package this app consumes. Installation never generates that output.

There is intentionally no generic `build` script: the Android native build is
an explicit step (`npm run android` or Gradle), not part of the root `build`.

Debug builds use the Android Gradle Plugin's standard debug signing
(`~/.android/debug.keystore`, generated automatically); no keystore is stored
in the repository. Release signing is configured in a later stage.
