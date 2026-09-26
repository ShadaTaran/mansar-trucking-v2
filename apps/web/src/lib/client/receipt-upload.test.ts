import type { ReceiptUploadAuthorization } from '@mansar/types';
import { describe, expect, it, vi } from 'vitest';

import {
  RECEIPT_UPLOAD_FILE_FIELD,
  ReceiptUploadFailedError,
  uploadReceiptBinary,
} from './receipt-upload';

/**
 * Zero real object storage. Every URL below is the synthetic `.test` origin
 * the Stage 6C fake also uses; no credential, no bucket, no provider domain
 * and no signed capability appears anywhere in this file.
 */
const UPLOAD_URL = 'https://storage.example.test/upload';
const PUT_URL = 'https://storage.example.test/object/receipt';
const RECEIPT_ID = '019a0000-0000-7000-8000-000000000003';

const POST_AUTH: ReceiptUploadAuthorization = {
  receiptId: RECEIPT_ID,
  method: 'POST',
  url: UPLOAD_URL,
  fields: {
    key: 'receipts/synthetic-expense/synthetic-receipt',
    'Content-Type': 'image/jpeg',
    policy: 'synthetic-policy',
    'x-amz-signature': 'synthetic-signature',
  },
  expiresAt: '2026-09-24T00:05:00.000Z',
};

const PUT_AUTH: ReceiptUploadAuthorization = {
  receiptId: RECEIPT_ID,
  method: 'PUT',
  url: PUT_URL,
  headers: { 'Content-Type': 'image/png', 'x-amz-date': '20260924T000000Z' },
  expiresAt: '2026-09-24T00:05:00.000Z',
};

const file = (type = 'image/jpeg') =>
  new File([new Uint8Array([1, 2, 3, 4])], 'receipt.jpg', { type });

function recorder(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('uploadReceiptBinary — POST branch', () => {
  it('posts to the authorization URL', async () => {
    const { impl, calls } = recorder(() => new Response(null, { status: 204 }));
    await uploadReceiptBinary(POST_AUTH, file(), impl);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(UPLOAD_URL);
    expect(calls[0]!.init?.method).toBe('POST');
  });

  it('preserves every signed field verbatim', async () => {
    const { impl, calls } = recorder(() => new Response(null, { status: 204 }));
    await uploadReceiptBinary(POST_AUTH, file(), impl);

    const form = calls[0]!.init?.body as FormData;
    for (const [name, value] of Object.entries(POST_AUTH.fields)) {
      expect(form.get(name)).toBe(value);
    }
  });

  it('puts the file last, after every field', async () => {
    const { impl, calls } = recorder(() => new Response(null, { status: 204 }));
    await uploadReceiptBinary(POST_AUTH, file(), impl);

    const form = calls[0]!.init?.body as FormData;
    const names = [...form.keys()];
    // The S3 POST contract ignores anything after the file part, so the
    // ordering is the difference between an upload and a silent no-op.
    expect(names).toEqual([
      'key',
      'Content-Type',
      'policy',
      'x-amz-signature',
      RECEIPT_UPLOAD_FILE_FIELD,
    ]);
    expect(names.at(-1)).toBe('file');
  });

  it('sends the actual File as the last entry', async () => {
    const { impl, calls } = recorder(() => new Response(null, { status: 204 }));
    const chosen = file();
    await uploadReceiptBinary(POST_AUTH, chosen, impl);

    const form = calls[0]!.init?.body as FormData;
    const entries = [...form.entries()];
    expect(entries.at(-1)![0]).toBe(RECEIPT_UPLOAD_FILE_FIELD);
    expect(entries.at(-1)![1]).toBe(chosen);
  });

  it('never sets a multipart content-type by hand', async () => {
    const { impl, calls } = recorder(() => new Response(null, { status: 204 }));
    await uploadReceiptBinary(POST_AUTH, file(), impl);

    // The browser must generate the boundary; a hand-set header omits it.
    expect(calls[0]!.init?.headers).toBeUndefined();
  });

  it.each([200, 201, 204])('treats %d as success', async (status) => {
    const { impl } = recorder(() => new Response(null, { status }));
    // An S3-compatible POST answers 204 by default, so requiring 200 would
    // reject every successful upload.
    await expect(uploadReceiptBinary(POST_AUTH, file(), impl)).resolves.toBe(
      undefined,
    );
  });
});

describe('uploadReceiptBinary — PUT branch', () => {
  it('puts to the authorization URL with the file as the body', async () => {
    const { impl, calls } = recorder(() => new Response(null, { status: 200 }));
    const chosen = file('image/png');
    await uploadReceiptBinary(PUT_AUTH, chosen, impl);

    expect(calls[0]!.url).toBe(PUT_URL);
    expect(calls[0]!.init?.method).toBe('PUT');
    expect(calls[0]!.init?.body).toBe(chosen);
  });

  it('sends exactly the signed headers and nothing else', async () => {
    const { impl, calls } = recorder(() => new Response(null, { status: 200 }));
    await uploadReceiptBinary(PUT_AUTH, file('image/png'), impl);

    expect(calls[0]!.init?.headers).toEqual(PUT_AUTH.headers);
  });

  it('builds no FormData for a PUT', async () => {
    const { impl, calls } = recorder(() => new Response(null, { status: 200 }));
    await uploadReceiptBinary(PUT_AUTH, file('image/png'), impl);
    expect(calls[0]!.init?.body).not.toBeInstanceOf(FormData);
  });

  it.each([200, 201, 204])('treats %d as success', async (status) => {
    const { impl } = recorder(() => new Response(null, { status }));
    await expect(
      uploadReceiptBinary(PUT_AUTH, file('image/png'), impl),
    ).resolves.toBe(undefined);
  });
});

describe('uploadReceiptBinary — Mansar credentials never leave the app', () => {
  it.each([
    ['POST', POST_AUTH],
    ['PUT', PUT_AUTH],
  ])('sends no auth, cookie or credentials on a %s', async (_label, auth) => {
    const { impl, calls } = recorder(() => new Response(null, { status: 204 }));
    await uploadReceiptBinary(auth, file(), impl);

    const init = calls[0]!.init;
    // `credentials` is left unset on purpose: fetch defaults to
    // 'same-origin', which sends nothing to a third-party endpoint.
    expect(init).not.toHaveProperty('credentials');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
  });

  it.each([
    ['POST', POST_AUTH],
    ['PUT', PUT_AUTH],
  ])('never rewrites the %s URL through the BFF', async (_label, auth) => {
    const { impl, calls } = recorder(() => new Response(null, { status: 204 }));
    await uploadReceiptBinary(auth, file(), impl);
    expect(calls[0]!.url).not.toContain('/api/backend');
    expect(calls[0]!.url.startsWith('https://storage.example.test')).toBe(true);
  });

  it('uses only the injected fetch, never the global one', async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    try {
      const { impl } = recorder(() => new Response(null, { status: 204 }));
      await uploadReceiptBinary(POST_AUTH, file(), impl);
      // A call to the global would be the seam through which
      // authenticatedFetch's refresh-on-401 could ever reappear.
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('uploadReceiptBinary — failure', () => {
  it.each([400, 403, 404, 413, 500, 503])(
    'reports %d as one fixed failure',
    async (status) => {
      const { impl } = recorder(
        () => new Response('<Error><Code>Leaky</Code></Error>', { status }),
      );
      const error = await uploadReceiptBinary(POST_AUTH, file(), impl).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ReceiptUploadFailedError);
      expect((error as ReceiptUploadFailedError).code).toBe(
        'receipt_upload_failed',
      );
    },
  );

  it('reports a network failure as the same fixed failure', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const error = await uploadReceiptBinary(POST_AUTH, file(), impl).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ReceiptUploadFailedError);
  });

  /**
   * The provider's own words must never reach an admin, and the only way to
   * prove that is to make reading them impossible to do silently.
   *
   * This deliberately does **not** wrap a native `Response` in a Proxy. A
   * native `Response`'s accessors are brand-checked against internal slots,
   * and forwarding them through `Reflect.get` with the proxy as the receiver
   * makes `response.ok` throw a `TypeError` instead of returning `false`.
   * The helper reads `response.ok` outside its try/catch, so that `TypeError`
   * would propagate and be caught by the test's own `.catch` — the
   * assertions would pass without the non-2xx path ever executing. That is
   * the false positive this shape exists to remove.
   *
   * A Response-*shaped* plain object has no internal slots, so `ok` really
   * is read, really is `false`, and the failure really is the helper's.
   */
  const PROVIDER_BODY =
    '<Error><Code>AccessDenied</Code><Bucket>real-bucket</Bucket>' +
    '<Message>signature mismatch for policy</Message></Error>';

  /** Every body-reading surface of the fetch Response contract. */
  const BODY_SURFACES = [
    'body',
    'text',
    'json',
    'arrayBuffer',
    'blob',
    'formData',
    'bytes',
  ] as const;

  function guardedResponse(): {
    readonly response: Response;
    readonly consulted: PropertyKey[];
  } {
    const consulted: PropertyKey[] = [];
    const readBody = () => {
      throw new Error('the helper read the provider response body');
    };
    const target: Record<PropertyKey, unknown> = {
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      // Present and readable, so an accidental read is recorded rather than
      // failing for some unrelated reason.
      body: PROVIDER_BODY,
    };
    for (const surface of BODY_SURFACES) {
      if (surface !== 'body') {
        target[surface] = readBody;
      }
    }
    const response = new Proxy(target, {
      get(t, property, receiver) {
        consulted.push(property);
        return Reflect.get(t, property, receiver) as unknown;
      },
    }) as unknown as Response;
    return { response, consulted };
  }

  /**
   * `then` is read by the promise machinery when the fake fetch's promise
   * resolves to this object, not by the helper inspecting the response, so
   * it is excluded from what counts as a consulted response member.
   */
  const members = (consulted: PropertyKey[]): PropertyKey[] =>
    consulted.filter((property) => property !== 'then');

  it('reaches the non-2xx path and throws the one fixed error', async () => {
    const { response, consulted } = guardedResponse();
    const impl = vi.fn(async () => response) as unknown as typeof fetch;

    const error = await uploadReceiptBinary(POST_AUTH, file(), impl).catch(
      (e: unknown) => e,
    );

    // The proof that the intended path ran: `ok` was actually read.
    expect(members(consulted)).toContain('ok');
    expect(error).toBeInstanceOf(ReceiptUploadFailedError);
    expect((error as ReceiptUploadFailedError).code).toBe(
      'receipt_upload_failed',
    );
    expect((error as Error).message).toBe('receipt upload failed');
  });

  it('consults only response.ok, and nothing else', async () => {
    const { response, consulted } = guardedResponse();
    const impl = vi.fn(async () => response) as unknown as typeof fetch;

    await uploadReceiptBinary(POST_AUTH, file(), impl).catch(() => undefined);

    // Stronger than checking a list of forbidden names: the status, the
    // status text and every body surface are all off limits, so this fails
    // the moment the helper starts looking at anything but `ok`.
    expect(members(consulted)).toEqual(['ok']);
  });

  it.each(BODY_SURFACES)('never touches response.%s', async (surface) => {
    const { response, consulted } = guardedResponse();
    const impl = vi.fn(async () => response) as unknown as typeof fetch;

    await uploadReceiptBinary(POST_AUTH, file(), impl).catch(() => undefined);

    expect(members(consulted)).not.toContain(surface);
  });

  it('would notice if the body were read, so the guard is not vacuous', () => {
    const { response, consulted } = guardedResponse();

    // Reading the body through the same seam the helper would use is
    // recorded and throws, which is what makes the assertions above mean
    // something rather than passing because nothing was ever instrumented.
    expect(() =>
      (response as unknown as { text: () => string }).text(),
    ).toThrow('the helper read the provider response body');
    expect(members(consulted)).toContain('text');
  });

  it('leaks no provider detail, URL, policy or signature into the error', async () => {
    const { response } = guardedResponse();
    const impl = vi.fn(async () => response) as unknown as typeof fetch;

    const error = await uploadReceiptBinary(POST_AUTH, file(), impl).catch(
      (e: unknown) => e,
    );

    const text = `${String(error)} ${JSON.stringify(error)} ${
      (error as Error).stack ?? ''
    }`;
    for (const forbidden of [
      'AccessDenied',
      'real-bucket',
      'signature mismatch',
      POST_AUTH.url,
      'synthetic-policy',
      'synthetic-signature',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
  it('keeps the signed capability out of the error it throws', async () => {
    const { impl } = recorder(() => new Response(null, { status: 500 }));
    const error = await uploadReceiptBinary(POST_AUTH, file(), impl).catch(
      (e: unknown) => e,
    );
    const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`;
    expect(text).not.toContain(UPLOAD_URL);
    expect(text).not.toContain('synthetic-signature');
    expect(text).not.toContain('synthetic-policy');
  });
});
