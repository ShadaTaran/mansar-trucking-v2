/**
 * Jest stand-in for the MansarConfig native module. Defaults to the debug
 * value; tests override `__mansarConfigFake.apiBaseUrl` to prove the
 * staging and fail-closed (empty) cases without any native code.
 */
export const __mansarConfigFake = {
  apiBaseUrl: 'http://10.0.2.2:3001',
  reset(): void {
    this.apiBaseUrl = 'http://10.0.2.2:3001';
  },
};

const NativeMansarConfig = {
  getConstants: () => ({ apiBaseUrl: __mansarConfigFake.apiBaseUrl }),
};

export default NativeMansarConfig;
