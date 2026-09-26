import type { ReceiptUploadAuthorization } from '@mansar/types';

/**
 * The browser's direct upload of a receipt image to object storage.
 *
 * This is the one request in the admin app that does **not** go through the
 * BFF. The binary never touches `/api/backend`, the Next server or Nest: the
 * API only authorizes the upload and afterwards verifies that it arrived
 * (ADR 0009). There is deliberately no Next upload route to add one back.
 *
 * It therefore must not use `authenticatedFetch`, and the reasons are
 * specific rather than stylistic. `authenticatedFetch` sets
 * `credentials: 'same-origin'` and retries a 401 by asking the BFF to
 * refresh the session — against a third-party origin the first is pointless
 * and the second is actively wrong, because a provider answering 401 (an
 * expired signature, say) would trigger a Mansar auth refresh and could log
 * the admin out of the application over a storage problem.
 *
 * So: plain `fetch`, no `credentials` option, no `Authorization` header, no
 * cookie, no refresh, no `/api/backend` prefix. `fetch` defaults to
 * `credentials: 'same-origin'`, which sends nothing to a cross-origin
 * endpoint, so the safe behaviour is the default and is not overridden here.
 *
 * The authorization is a short-lived bearer capability. Its URL, form fields
 * and headers are never logged, never persisted and never rendered, and the
 * provider's response body is never read — it cannot be trusted as business
 * state and could contain provider detail that has no business in this app.
 * Only Nest's confirmation decides whether a receipt exists.
 */

/**
 * The multipart field carrying the bytes, and it must be **last**.
 *
 * Both facts come from the S3 POST Object form contract, which the selected
 * provider implements: the field is named `file`, and "the file or content
 * must be the last field in the form. Any fields below it are ignored."
 * Appending it before the signed policy fields would silently upload
 * nothing, which is exactly the kind of failure that only shows up against a
 * real bucket — so the ordering is asserted in this module's tests.
 */
export const RECEIPT_UPLOAD_FILE_FIELD = 'file';

/**
 * The single failure this module reports.
 *
 * One category on purpose. A provider returns XML or HTML describing its own
 * internals, and none of that belongs in front of an admin or inside an
 * error string, so the cause is never attached and the body is never read.
 * The caller turns this into one fixed sentence.
 */
export class ReceiptUploadFailedError extends Error {
  readonly code = 'receipt_upload_failed' as const;

  constructor() {
    super('receipt upload failed');
    this.name = 'ReceiptUploadFailedError';
  }
}

/** Resolved at call time so a test's stubbed global is honoured. */
const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

/**
 * Uploads one file under one authorization, then returns.
 *
 * Success is `response.ok`, not a particular status. An S3-compatible POST
 * with no `success_action_status` field answers **204** with an empty body,
 * so requiring 200 would reject every successful upload; 201 is also
 * possible where a provider sets that field. Nothing about the response is
 * inspected beyond `ok`.
 */
export async function uploadReceiptBinary(
  authorization: ReceiptUploadAuthorization,
  file: File,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<void> {
  let response: Response;
  try {
    response =
      authorization.method === 'POST'
        ? await postUpload(authorization, file, fetchImpl)
        : await putUpload(authorization, file, fetchImpl);
  } catch {
    // A network failure, a DNS failure, a CORS rejection: all the same
    // answer, and none of their detail reaches the caller.
    throw new ReceiptUploadFailedError();
  }
  if (!response.ok) {
    throw new ReceiptUploadFailedError();
  }
}

function postUpload(
  authorization: Extract<ReceiptUploadAuthorization, { method: 'POST' }>,
  file: File,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const form = new FormData();
  // Verbatim, in the order the provider gave them: these are signed policy
  // material, and renaming, filtering or reordering one breaks the
  // signature. They are opaque to this application by design.
  for (const [name, value] of Object.entries(authorization.fields)) {
    form.append(name, value);
  }
  // Last, always. See RECEIPT_UPLOAD_FILE_FIELD.
  form.append(RECEIPT_UPLOAD_FILE_FIELD, file);

  // No `headers` at all: the browser must generate the multipart boundary,
  // and setting Content-Type by hand would omit it and break the upload.
  return fetchImpl(authorization.url, { method: 'POST', body: form });
}

function putUpload(
  authorization: Extract<ReceiptUploadAuthorization, { method: 'PUT' }>,
  file: File,
  fetchImpl: typeof fetch,
): Promise<Response> {
  // The signed headers, exactly as given and nothing else. An extra header
  // is not harmless here: anything outside what was signed can invalidate
  // the signature.
  //
  // No provider in Stage 6 returns this branch — the selected adapter signs
  // a POST — but the shared contract is a union over both, so a `method`
  // this code could not handle would be a crash waiting for the day a
  // provider changes. Implementing it now keeps that change inside an
  // adapter, which is the whole point of the union.
  return fetchImpl(authorization.url, {
    method: 'PUT',
    headers: { ...authorization.headers },
    body: file,
  });
}
