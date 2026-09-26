/* global jest */
// The codegen specs call TurboModuleRegistry.getEnforcing at import time,
// which throws without a native runtime; use the manual mocks everywhere.
jest.mock('./src/specs/NativeMansarConfig');
jest.mock('./src/specs/NativeReceiptPicker');
