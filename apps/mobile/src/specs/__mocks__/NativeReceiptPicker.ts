/**
 * Jest stand-in for the ReceiptPicker native module.
 *
 * The native picker cannot run under Jest, so tests drive this fake instead:
 * they queue the next outcome — a chosen file, a cancellation, or a rejection
 * with a fixed code — and assert what the JS wrapper makes of it. Everything
 * the wrapper is responsible for (cancellation, MIME and size validation,
 * fail-closed handling of a malformed native result) is therefore covered
 * without any Android code.
 */

interface PickedFile {
  uri: string;
  contentType: string;
  byteSize: number;
}

type Outcome =
  | { readonly kind: 'file'; readonly file: unknown }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'reject'; readonly error: unknown }
  /** A shape the real module would never emit, for fail-closed tests. */
  | { readonly kind: 'raw'; readonly value: unknown };

export const __receiptPickerFake = {
  calls: 0,
  next: { kind: 'cancelled' } as Outcome,

  /** The next call resolves with this file. */
  resolveFile(file: PickedFile | unknown): void {
    this.next = { kind: 'file', file };
  },
  /** The next call resolves as a cancellation. */
  resolveCancelled(): void {
    this.next = { kind: 'cancelled' };
  },
  /** The next call rejects. */
  reject(error: unknown): void {
    this.next = { kind: 'reject', error };
  },
  /** The next call resolves with an arbitrary (malformed) value. */
  resolveRaw(value: unknown): void {
    this.next = { kind: 'raw', value };
  },
  reset(): void {
    this.calls = 0;
    this.next = { kind: 'cancelled' };
  },
};

const NativeReceiptPicker = {
  pickReceiptImage: async (): Promise<unknown> => {
    __receiptPickerFake.calls += 1;
    const outcome = __receiptPickerFake.next;
    switch (outcome.kind) {
      case 'file':
        return { file: outcome.file };
      case 'cancelled':
        return { file: null };
      case 'raw':
        return outcome.value;
      case 'reject':
        throw outcome.error;
    }
  },
};

export default NativeReceiptPicker;
