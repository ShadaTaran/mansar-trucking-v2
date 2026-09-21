/* global jest */
// The codegen spec calls TurboModuleRegistry.getEnforcing at import time,
// which throws without a native runtime; use the manual mock everywhere.
jest.mock('./src/specs/NativeMansarConfig');
