import type { ReceiptUploadAuthorization } from '@mansar/types';

import type { PickedReceiptFile } from './receipt-picker';

/**
 * Uploads one receipt binary straight to object storage (ADR 0009).
 *
 * The binary never touches the Mansar API: the server authorizes, the device
 * uploads, and the server then verifies the object arrived. Nothing here goes
 * through `authenticatedFetch`, `@mansar/api-client`, the API base URL or any
 * BFF, and **no Mansar bearer token is ever attached** — the signed
 * authorization is the only credential the provider gets, and adding a second
 * one would leak our token to a third party.
 *
 * Failure is always the same error with the same code. The provider's response
 * body is never read: it is XML that can name the bucket, the key, the policy
 * or the signature, and none of that belongs in a driver's error message or in
 * a log. Only the status is consulted.
 *
 * The two branches use different transports, and that is not a style choice:
 *
 * - **POST** builds a `FormData`. React Native's FormData keeps parts in
 *   append order and represents a file as `{uri, type}`, which `fetch` passes
 *   through to the native layer unchanged.
 * - **PUT** must use `XMLHttpRequest` directly. React Native's `fetch` is the
 *   whatwg-fetch polyfill, whose body handling has no branch for a plain
 *   object: a `{uri}` body falls through to
 *   `Object.prototype.toString.call(body)` and would upload the literal
 *   fifteen-byte string `"[object Object]"`. The native networking module
 *   *does* support a `uri` body, so going one level below `fetch` is the fix.
 */

/** The one failure a caller ever sees from a provider upload. */
export class ReceiptUploadFailedError extends Error {
  readonly code = 'receipt_upload_failed' as const;

  constructor() {
    super('receipt upload failed');
    this.name = 'ReceiptUploadFailedError';
  }
}

/** The multipart field the provider expects the binary under. */
export const RECEIPT_UPLOAD_FILE_FIELD = 'file';

/**
 * A React Native file part: a local URI plus its type.
 *
 * `type` is mandatory rather than decorative — the Android networking module
 * refuses a binary multipart part that has no content type, and for a raw PUT
 * the content type must come from the signed headers. No `name` is set,
 * because FormData treats it as optional and a client-chosen filename is not
 * receipt metadata.
 */
interface NativeFilePart {
  readonly uri: string;
  readonly type: string;
}

/** The minimum of XMLHttpRequest this helper drives, so tests can supply it. */
export interface UploadXhr {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: unknown): void;
  readonly status: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  ontimeout: (() => void) | null;
}

export interface UploadTransport {
  readonly fetch: typeof fetch;
  readonly createXhr: () => UploadXhr;
}

const defaultTransport: UploadTransport = {
  fetch: (...args) => globalThis.fetch(...args),
  createXhr: () => new XMLHttpRequest() as unknown as UploadXhr,
};

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * POST: every signed field verbatim, then the file last.
 *
 * Order matters to the provider — the file must be the last part, and any
 * field after it is ignored — so the fields are appended in the exact
 * iteration order the authorization presented them, and the file follows.
 * No `Content-Type` is set: the native layer generates `multipart/form-data`
 * with its own boundary, and setting one by hand would produce a boundary
 * that does not match the body.
 */
async function postUpload(
  authorization: Extract<ReceiptUploadAuthorization, { method: 'POST' }>,
  file: PickedReceiptFile,
  transport: UploadTransport,
): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(authorization.fields)) {
    form.append(name, value);
  }
  const part: NativeFilePart = { uri: file.uri, type: file.contentType };
  form.append(RECEIPT_UPLOAD_FILE_FIELD, part as unknown as Blob);
  return transport.fetch(authorization.url, { method: 'POST', body: form });
}

/**
 * PUT: the signed headers exactly, and the native URI body.
 *
 * Headers are applied as given and nothing is added or renamed — including
 * the content type, which the authorization must carry because the native
 * layer refuses a URI body without one. Deliberately not `fetch`: see the
 * module comment.
 */
function putUpload(
  authorization: Extract<ReceiptUploadAuthorization, { method: 'PUT' }>,
  file: PickedReceiptFile,
  transport: UploadTransport,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (!settled) {
        settled = true;
        reject(new ReceiptUploadFailedError());
      }
    };
    let xhr: UploadXhr;
    try {
      xhr = transport.createXhr();
      xhr.onload = () => {
        if (!settled) {
          settled = true;
          resolve(xhr.status);
        }
      };
      xhr.onerror = fail;
      xhr.onabort = fail;
      xhr.ontimeout = fail;
      xhr.open('PUT', authorization.url);
      for (const [name, value] of Object.entries(authorization.headers)) {
        xhr.setRequestHeader(name, value);
      }
      // The object the native networking module understands as a file body.
      xhr.send({ uri: file.uri });
    } catch {
      fail();
    }
  });
}

/**
 * Performs the one authorized upload.
 *
 * Resolves on any 2xx — a bare presigned POST answers 204 with an empty body —
 * and throws `ReceiptUploadFailedError` on anything else, including a network
 * failure, an abort and a timeout. The provider's body is never read.
 */
export async function uploadReceiptBinary(
  authorization: ReceiptUploadAuthorization,
  file: PickedReceiptFile,
  transport: UploadTransport = defaultTransport,
): Promise<void> {
  if (authorization.method === 'PUT') {
    const status = await putUpload(authorization, file, transport);
    if (!isSuccess(status)) {
      throw new ReceiptUploadFailedError();
    }
    return;
  }

  let response: Response;
  try {
    response = await postUpload(authorization, file, transport);
  } catch {
    throw new ReceiptUploadFailedError();
  }
  if (!response.ok) {
    throw new ReceiptUploadFailedError();
  }
}
