import NativeReceiptPicker from '../specs/NativeReceiptPicker';

/**
 * The JavaScript boundary around the receipt picker native module.
 *
 * Every rule about what may be uploaded lives here, not in a component and
 * not in Kotlin: a component should not be the thing that decides whether a
 * HEIC is acceptable, and the native side should report what the platform
 * says rather than adjudicate the contract. So this validates the frozen
 * Stage 6 window — the three image types and the 1 B .. 10 MiB size — before
 * any authorization is requested, which means an unsupported pick costs no
 * round trip and never reaches the API.
 *
 * It is fail-closed by construction: anything the native module returns that
 * is not exactly the expected shape is treated as no selection at all, with a
 * fixed local code. Nothing here reads, logs or stores the URI beyond handing
 * it back to the caller for this one upload.
 */

/** The three frozen receipt image types, exactly as the API enumerates them. */
export const RECEIPT_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type ReceiptContentType = (typeof RECEIPT_CONTENT_TYPES)[number];

/** The frozen Stage 6 size window, in bytes. */
export const RECEIPT_MIN_BYTE_SIZE = 1;
export const RECEIPT_MAX_BYTE_SIZE = 10 * 1024 * 1024;

/**
 * A local file chosen for upload.
 *
 * `uri` never leaves the device — it is not receipt metadata and the API has
 * no field for it. Only `contentType` and `byteSize` are declared to the
 * upload-intent endpoint.
 */
export interface PickedReceiptFile {
  readonly uri: string;
  readonly contentType: ReceiptContentType;
  readonly byteSize: number;
}

/** Why a pick could not be used. Fixed codes; never provider or OS text. */
export type ReceiptPickErrorCode =
  | 'receipt_pick_failed'
  | 'receipt_type_unsupported'
  | 'receipt_too_large'
  | 'receipt_empty';

export class ReceiptPickError extends Error {
  readonly code: ReceiptPickErrorCode;

  constructor(code: ReceiptPickErrorCode) {
    super(code);
    this.name = 'ReceiptPickError';
    this.code = code;
  }
}

export const RECEIPT_PICK_MESSAGES: Readonly<
  Record<ReceiptPickErrorCode, string>
> = {
  receipt_pick_failed: 'That image could not be read. Choose another.',
  receipt_type_unsupported:
    'Receipts must be a JPEG, PNG or WebP image. Choose another.',
  receipt_too_large: 'That image is larger than 10 MB. Choose a smaller one.',
  receipt_empty: 'That image is empty. Choose another.',
};

export function receiptPickMessage(error: unknown): string | null {
  return error instanceof ReceiptPickError
    ? RECEIPT_PICK_MESSAGES[error.code]
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReceiptContentType(value: unknown): value is ReceiptContentType {
  // An exact match, deliberately: `IMAGE/JPEG` and
  // `image/jpeg; charset=utf-8` are rejected rather than repaired, because
  // the value is signed into the upload policy and stored in a column with
  // the same CHECK, so normalizing here would mean uploading under a header
  // the server never declared.
  return (
    typeof value === 'string' &&
    (RECEIPT_CONTENT_TYPES as readonly string[]).includes(value)
  );
}

/** A local content URI, which is what both Android picker paths return. */
function isContentUri(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('content://');
}

/**
 * Opens the platform picker.
 *
 * Resolves `null` when the driver cancelled — an ordinary outcome, not an
 * error. Throws `ReceiptPickError` with a fixed code when the selection
 * cannot be used, so the caller has one thing to map to text.
 */
export async function pickReceiptFile(): Promise<PickedReceiptFile | null> {
  let result: unknown;
  try {
    result = await NativeReceiptPicker.pickReceiptImage();
  } catch {
    // The native side already refuses to put a URI, path or OS message in its
    // rejection; discarding the cause here means it cannot leak even if that
    // ever changed.
    throw new ReceiptPickError('receipt_pick_failed');
  }

  if (!isRecord(result) || !('file' in result)) {
    throw new ReceiptPickError('receipt_pick_failed');
  }
  // Cancellation is exactly `{file: null}`, which is what the native module
  // emits via `putNull`. `undefined` is not that shape — it is a result whose
  // `file` key exists but carries nothing, which no working module produces —
  // so it fails closed rather than being read as "the driver cancelled". The
  // difference matters: silently treating a malformed result as a cancellation
  // would make a broken picker look like an ordinary dismissal.
  const file = result.file;
  if (file === null) {
    return null;
  }
  if (!isRecord(file)) {
    throw new ReceiptPickError('receipt_pick_failed');
  }

  const { uri, contentType, byteSize } = file;
  if (!isContentUri(uri)) {
    throw new ReceiptPickError('receipt_pick_failed');
  }
  // A missing MIME type is a failure to read metadata, not an unsupported
  // image: the platform exposes it for picker results, and guessing one from
  // a filename extension is exactly what this must not do.
  if (contentType === undefined || contentType === null) {
    throw new ReceiptPickError('receipt_pick_failed');
  }
  if (!isReceiptContentType(contentType)) {
    throw new ReceiptPickError('receipt_type_unsupported');
  }
  if (typeof byteSize !== 'number' || !Number.isInteger(byteSize)) {
    throw new ReceiptPickError('receipt_pick_failed');
  }
  if (byteSize < RECEIPT_MIN_BYTE_SIZE) {
    throw new ReceiptPickError('receipt_empty');
  }
  if (byteSize > RECEIPT_MAX_BYTE_SIZE) {
    throw new ReceiptPickError('receipt_too_large');
  }

  return { uri, contentType, byteSize };
}
