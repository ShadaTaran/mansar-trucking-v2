import type { ReceiptUploadAuthorization } from '@mansar/types';

import type { PickedReceiptFile } from './receipt-picker';
import {
  RECEIPT_UPLOAD_FILE_FIELD,
  ReceiptUploadFailedError,
  uploadReceiptBinary,
  type UploadTransport,
  type UploadXhr,
} from './receipt-upload';

const RECEIPT_ID = '019a0000-0000-7000-8000-000000000003';

const FILE: PickedReceiptFile = {
  uri: 'content://media/external/images/media/1234',
  contentType: 'image/jpeg',
  byteSize: 2048,
};

const POST_AUTH: ReceiptUploadAuthorization = {
  receiptId: RECEIPT_ID,
  method: 'POST',
  url: 'https://storage.example.test/receipts',
  fields: {
    key: 'synthetic/object/key.jpg',
    'x-amz-algorithm': 'SYNTHETIC-HMAC',
    'x-amz-credential': 'synthetic-credential',
    policy: 'synthetic-policy',
    'x-amz-signature': 'synthetic-signature',
  },
  expiresAt: '2026-09-24T01:05:00.000Z',
};

const PUT_AUTH: ReceiptUploadAuthorization = {
  receiptId: RECEIPT_ID,
  method: 'PUT',
  url: 'https://storage.example.test/receipts/synthetic?signature=synthetic',
  headers: {
    'content-type': 'image/jpeg',
    'x-amz-date': '20260924T010000Z',
    'x-amz-content-sha256': 'synthetic-digest',
  },
  expiresAt: '2026-09-24T01:05:00.000Z',
};

/**
 * React Native's FormData, reproduced for the test environment.
 *
 * Jest runs with the standard Web `FormData`, which has no `getParts()` and
 * coerces a non-Blob object part to the string `"[object Object]"` — so
 * asserting against it would prove nothing about the device. This mirrors
 * `react-native/Libraries/Network/FormData.js` exactly: parts are kept in
 * append order, a `{uri}` value becomes a file part, `type` becomes the part's
 * content type, and `name` — which the helper deliberately never sets — is
 * what would add a `filename` to the content disposition.
 */
class ReactNativeFormData {
  private readonly parts: Array<[string, unknown]> = [];

  append(key: string, value: unknown): void {
    this.parts.push([key, value]);
  }

  getParts(): Array<Record<string, unknown>> {
    return this.parts.map(([name, value]) => {
      const headers: Record<string, string> = {
        'content-disposition': `form-data; name="${name}"`,
      };
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        const file = value as { name?: unknown; type?: unknown };
        if (typeof file.name === 'string') {
          headers['content-disposition'] += `; filename="${file.name}"`;
        }
        if (typeof file.type === 'string') {
          headers['content-type'] = file.type;
        }
        return { ...(value as object), headers, fieldName: name };
      }
      return { string: String(value), headers, fieldName: name };
    });
  }
}

/** The parts a FormData was built from, in append order. */
interface RecordedPart {
  readonly name: string;
  readonly value: unknown;
}

function partsOf(body: unknown): RecordedPart[] {
  const parts = (
    body as { getParts?: () => Array<Record<string, unknown>> }
  ).getParts?.();
  if (!parts) {
    throw new Error('the body was not a FormData');
  }
  return parts.map((part) => ({
    name: String(part.fieldName),
    value: 'string' in part ? part.string : part,
  }));
}

interface PostCall {
  readonly url: string;
  readonly init: RequestInit;
}

function postTransport(
  reply: () => Partial<Response> | Promise<Partial<Response>>,
): { transport: UploadTransport; calls: PostCall[] } {
  const calls: PostCall[] = [];
  const transport: UploadTransport = {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return (await reply()) as Response;
    }) as unknown as typeof fetch,
    createXhr: () => {
      throw new Error('the POST branch must not create an XMLHttpRequest');
    },
  };
  return { transport, calls };
}

interface XhrCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Array<[string, string]>;
  readonly body: unknown;
}

/** A recording stand-in for XMLHttpRequest that settles how a test asks. */
function xhrTransport(options: {
  readonly status?: number;
  readonly event?: 'load' | 'error' | 'abort' | 'timeout';
  readonly throwOn?: 'open' | 'send' | 'header';
}): { transport: UploadTransport; calls: XhrCall[] } {
  const calls: XhrCall[] = [];
  const transport: UploadTransport = {
    fetch: (() => {
      throw new Error('the PUT branch must not use fetch');
    }) as unknown as typeof fetch,
    createXhr: () => {
      const headers: Array<[string, string]> = [];
      let method = '';
      let url = '';
      const xhr: UploadXhr = {
        status: options.status ?? 200,
        onload: null,
        onerror: null,
        onabort: null,
        ontimeout: null,
        open(m, u) {
          if (options.throwOn === 'open') {
            throw new Error('open failed');
          }
          method = m;
          url = u;
        },
        setRequestHeader(name, value) {
          if (options.throwOn === 'header') {
            throw new Error('header failed');
          }
          headers.push([name, value]);
        },
        send(body) {
          calls.push({ method, url, headers, body });
          if (options.throwOn === 'send') {
            throw new Error('send failed');
          }
          const event = options.event ?? 'load';
          // Settle asynchronously, the way a real request does.
          setTimeout(() => {
            if (event === 'load') {
              xhr.onload?.();
            } else if (event === 'error') {
              xhr.onerror?.();
            } else if (event === 'abort') {
              xhr.onabort?.();
            } else {
              xhr.ontimeout?.();
            }
          }, 0);
        },
      };
      return xhr;
    },
  };
  return { transport, calls };
}

describe('POST direct upload', () => {
  // React Native's TypeScript config carries no DOM lib, so the ambient
  // FormData is reached through an alias rather than `globalThis.FormData`.
  const host = globalThis as unknown as { FormData: unknown };
  const WebFormData = host.FormData;

  beforeEach(() => {
    // The helper builds `new FormData()` from the ambient global, exactly as
    // it does on a device; here that global is React Native's shape.
    host.FormData = ReactNativeFormData;
  });

  afterEach(() => {
    host.FormData = WebFormData;
  });

  it('sends every signed field verbatim, in the order it was given', async () => {
    const { transport, calls } = postTransport(() => ({
      ok: true,
      status: 204,
    }));
    await uploadReceiptBinary(POST_AUTH, FILE, transport);

    expect(calls[0]!.url).toBe(POST_AUTH.url);
    expect(calls[0]!.init.method).toBe('POST');
    const parts = partsOf(calls[0]!.init.body);
    if (POST_AUTH.method !== 'POST') {
      throw new Error('fixture must be the POST branch');
    }
    const fieldNames = Object.keys(POST_AUTH.fields);
    expect(parts.slice(0, fieldNames.length).map((p) => p.name)).toEqual(
      fieldNames,
    );
    for (const [name, value] of Object.entries(POST_AUTH.fields)) {
      const part = parts.find((p) => p.name === name);
      expect(part?.value).toBe(value);
    }
  });

  it('appends the file last, under the field the provider expects', async () => {
    const { transport, calls } = postTransport(() => ({
      ok: true,
      status: 204,
    }));
    await uploadReceiptBinary(POST_AUTH, FILE, transport);

    const parts = partsOf(calls[0]!.init.body);
    // Anything after the file part is ignored by the provider.
    expect(parts.at(-1)?.name).toBe(RECEIPT_UPLOAD_FILE_FIELD);
    expect(RECEIPT_UPLOAD_FILE_FIELD).toBe('file');
  });

  it('gives the file part a content type, which the native layer requires', async () => {
    const { transport, calls } = postTransport(() => ({
      ok: true,
      status: 204,
    }));
    await uploadReceiptBinary(POST_AUTH, FILE, transport);

    const filePart = partsOf(calls[0]!.init.body).at(-1)!.value as Record<
      string,
      unknown
    >;
    expect(filePart.uri).toBe(FILE.uri);
    expect(filePart.type).toBe('image/jpeg');
    expect(filePart.headers).toMatchObject({ 'content-type': 'image/jpeg' });
  });

  it('sets no filename on the file part', async () => {
    const { transport, calls } = postTransport(() => ({
      ok: true,
      status: 204,
    }));
    await uploadReceiptBinary(POST_AUTH, FILE, transport);

    const filePart = partsOf(calls[0]!.init.body).at(-1)!.value as Record<
      string,
      unknown
    >;
    expect(filePart.name).toBeUndefined();
    const disposition = String(
      (filePart.headers as Record<string, string>)['content-disposition'],
    );
    expect(disposition).toBe('form-data; name="file"');
    expect(disposition).not.toContain('filename');
  });

  it('preserves an empty signed field value', async () => {
    const auth: ReceiptUploadAuthorization = {
      ...POST_AUTH,
      method: 'POST',
      fields: { key: 'synthetic/key.jpg', 'x-amz-meta-note': '' },
    };
    const { transport, calls } = postTransport(() => ({
      ok: true,
      status: 204,
    }));
    await uploadReceiptBinary(auth, FILE, transport);

    const parts = partsOf(calls[0]!.init.body);
    expect(parts.find((p) => p.name === 'x-amz-meta-note')?.value).toBe('');
  });

  it('attaches no Mansar authorization and sets no multipart content type', async () => {
    const { transport, calls } = postTransport(() => ({
      ok: true,
      status: 204,
    }));
    await uploadReceiptBinary(POST_AUTH, FILE, transport);

    // The provider gets the signed policy and nothing else of ours; the
    // boundary is the native layer's to generate.
    expect(calls[0]!.init.headers).toBeUndefined();
    const serialized = JSON.stringify(calls[0]!.init.headers ?? {});
    expect(serialized.toLowerCase()).not.toContain('authorization');
    expect(serialized.toLowerCase()).not.toContain('bearer');
    expect(serialized.toLowerCase()).not.toContain('multipart/form-data');
    expect(serialized.toLowerCase()).not.toContain('boundary');
  });

  it.each([200, 201, 202, 204, 299])(
    'accepts %s as success',
    async (status) => {
      const { transport } = postTransport(() => ({ ok: true, status }));
      await expect(
        uploadReceiptBinary(POST_AUTH, FILE, transport),
      ).resolves.toBeUndefined();
    },
  );

  it.each([400, 403, 404, 413, 500, 503])(
    'throws the one fixed error on %s',
    async (status) => {
      const { transport } = postTransport(() => ({ ok: false, status }));
      const error = (await uploadReceiptBinary(
        POST_AUTH,
        FILE,
        transport,
      ).catch((e: unknown) => e)) as ReceiptUploadFailedError;
      expect(error).toBeInstanceOf(ReceiptUploadFailedError);
      expect(error.code).toBe('receipt_upload_failed');
      expect(error.message).toBe('receipt upload failed');
    },
  );

  it('throws the same fixed error when the request never completes', async () => {
    const { transport } = postTransport(() => {
      throw new Error('network is unreachable');
    });
    const error = (await uploadReceiptBinary(POST_AUTH, FILE, transport).catch(
      (e: unknown) => e,
    )) as ReceiptUploadFailedError;
    expect(error).toBeInstanceOf(ReceiptUploadFailedError);
    expect(error.message).not.toContain('unreachable');
  });

  it('never reads the provider response body', async () => {
    const consulted: string[] = [];
    const BODY_SURFACES = [
      'text',
      'json',
      'blob',
      'arrayBuffer',
      'formData',
      'bytes',
    ] as const;
    // A Response-shaped plain object, never a native Response: forwarding a
    // real Response's brand-checked accessors through a Proxy would make
    // `ok` throw and the assertions would pass without the branch running.
    const target: Record<PropertyKey, unknown> = {
      ok: false,
      status: 403,
      body: '<Error><Code>AccessDenied</Code><Bucket>real-bucket</Bucket></Error>',
    };
    for (const surface of BODY_SURFACES) {
      target[surface] = () => {
        throw new Error('the helper read the provider response body');
      };
    }
    const response = new Proxy(target, {
      get(t, property, receiver) {
        consulted.push(String(property));
        return Reflect.get(t, property, receiver) as unknown;
      },
    }) as unknown as Response;

    const { transport } = postTransport(() => response);
    const error = (await uploadReceiptBinary(POST_AUTH, FILE, transport).catch(
      (e: unknown) => e,
    )) as ReceiptUploadFailedError;

    expect(error).toBeInstanceOf(ReceiptUploadFailedError);
    // `then` is read by the promise machinery, not by the helper.
    const members = consulted.filter((name) => name !== 'then');
    expect(members).toEqual(['ok']);
    for (const surface of [...BODY_SURFACES, 'body']) {
      expect(members).not.toContain(surface);
    }
  });

  it('leaks no provider detail into the error', async () => {
    const { transport } = postTransport(() => ({
      ok: false,
      status: 403,
      text: async () =>
        '<Error><Code>AccessDenied</Code><Bucket>real-bucket</Bucket></Error>',
    }));
    const error = (await uploadReceiptBinary(POST_AUTH, FILE, transport).catch(
      (e: unknown) => e,
    )) as ReceiptUploadFailedError;
    const shown = `${String(error)}${error.stack ?? ''}${JSON.stringify({
      ...error,
      message: error.message,
    })}`;
    for (const secret of [
      'AccessDenied',
      'real-bucket',
      'synthetic-policy',
      'synthetic-signature',
      'storage.example.test',
      'synthetic/object/key.jpg',
    ]) {
      expect(shown).not.toContain(secret);
    }
  });
});

describe('PUT direct upload', () => {
  it('uses XMLHttpRequest and never fetch', async () => {
    // fetch throws in this transport, so reaching it would fail the test.
    const { transport, calls } = xhrTransport({ status: 200 });
    await expect(
      uploadReceiptBinary(PUT_AUTH, FILE, transport),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe(PUT_AUTH.url);
  });

  it('sends the native URI body object, not a stringified one', async () => {
    // React Native's fetch would turn a plain {uri} body into the literal
    // string "[object Object]" and upload fifteen bytes of it; the object
    // must arrive intact.
    const { transport, calls } = xhrTransport({ status: 200 });
    await uploadReceiptBinary(PUT_AUTH, FILE, transport);

    expect(calls[0]!.body).toEqual({ uri: FILE.uri });
    expect(typeof calls[0]!.body).toBe('object');
    expect(calls[0]!.body).not.toBe('[object Object]');
    expect(String(calls[0]!.body)).toBe('[object Object]');
    expect(JSON.stringify(calls[0]!.body)).toContain(FILE.uri);
  });

  it('applies every signed header exactly, adding none', async () => {
    const { transport, calls } = xhrTransport({ status: 200 });
    await uploadReceiptBinary(PUT_AUTH, FILE, transport);

    if (PUT_AUTH.method !== 'PUT') {
      throw new Error('fixture must be the PUT branch');
    }
    expect(calls[0]!.headers).toEqual(Object.entries(PUT_AUTH.headers));
    const names = calls[0]!.headers.map(([name]) => name.toLowerCase());
    expect(names).not.toContain('authorization');
    expect(names).toContain('content-type');
  });

  it('attaches no Mansar bearer token', async () => {
    const { transport, calls } = xhrTransport({ status: 200 });
    await uploadReceiptBinary(PUT_AUTH, FILE, transport);
    const serialized = JSON.stringify(calls[0]!.headers).toLowerCase();
    expect(serialized).not.toContain('bearer');
    expect(serialized).not.toContain('authorization');
  });

  it.each([200, 201, 204, 299])('accepts %s as success', async (status) => {
    const { transport } = xhrTransport({ status });
    await expect(
      uploadReceiptBinary(PUT_AUTH, FILE, transport),
    ).resolves.toBeUndefined();
  });

  it.each([199, 300, 400, 403, 500, 503])(
    'throws the fixed error on %s',
    async (status) => {
      const { transport } = xhrTransport({ status });
      const error = (await uploadReceiptBinary(PUT_AUTH, FILE, transport).catch(
        (e: unknown) => e,
      )) as ReceiptUploadFailedError;
      expect(error).toBeInstanceOf(ReceiptUploadFailedError);
      expect(error.code).toBe('receipt_upload_failed');
    },
  );

  it.each(['error', 'abort', 'timeout'] as const)(
    'throws the fixed error on %s',
    async (event) => {
      const { transport } = xhrTransport({ event });
      const error = (await uploadReceiptBinary(PUT_AUTH, FILE, transport).catch(
        (e: unknown) => e,
      )) as ReceiptUploadFailedError;
      expect(error).toBeInstanceOf(ReceiptUploadFailedError);
      expect(error.message).toBe('receipt upload failed');
    },
  );

  it.each(['open', 'header', 'send'] as const)(
    'throws the fixed error when %s throws synchronously',
    async (throwOn) => {
      const { transport } = xhrTransport({ throwOn });
      const error = (await uploadReceiptBinary(PUT_AUTH, FILE, transport).catch(
        (e: unknown) => e,
      )) as ReceiptUploadFailedError;
      expect(error).toBeInstanceOf(ReceiptUploadFailedError);
      expect(error.message).not.toMatch(/open|header|send/);
    },
  );

  it('never reads a response body or text', async () => {
    // Every property access on the request object is recorded, so touching a
    // body reader would show up here even though the shape has none.
    const touched: string[] = [];
    const { transport } = xhrTransport({ status: 200 });
    const inner = transport.createXhr;
    const spying: UploadTransport = {
      fetch: transport.fetch,
      createXhr: () =>
        new Proxy(inner() as unknown as Record<PropertyKey, unknown>, {
          get(target, property, receiver) {
            touched.push(String(property));
            return Reflect.get(target, property, receiver) as unknown;
          },
          set(target, property, value) {
            target[property] = value;
            return true;
          },
        }) as unknown as UploadXhr,
    };
    await uploadReceiptBinary(PUT_AUTH, FILE, spying);

    for (const reader of [
      'responseText',
      'response',
      'responseType',
      'responseXML',
    ]) {
      expect(touched).not.toContain(reader);
    }
    // Only the status decides the outcome.
    expect(touched).toContain('status');
  });

  it('leaks no signed URL or header into the error', async () => {
    const { transport } = xhrTransport({ status: 403 });
    const error = (await uploadReceiptBinary(PUT_AUTH, FILE, transport).catch(
      (e: unknown) => e,
    )) as ReceiptUploadFailedError;
    const shown = `${String(error)}${error.stack ?? ''}${JSON.stringify({
      ...error,
      message: error.message,
    })}`;
    for (const secret of [
      'signature=synthetic',
      'synthetic-digest',
      'storage.example.test',
      FILE.uri,
    ]) {
      expect(shown).not.toContain(secret);
    }
  });
});

describe('the upload helper reaches no Mansar surface', () => {
  const host = globalThis as unknown as { FormData: unknown; fetch: unknown };
  const WebFormData = host.FormData;

  beforeEach(() => {
    host.FormData = ReactNativeFormData;
  });

  afterEach(() => {
    host.FormData = WebFormData;
  });

  it('sends only through the injected transport, never a global fetch', async () => {
    // A global fetch is how a Mansar-authenticated path would creep in, so
    // reaching for one here fails loudly rather than succeeding quietly.
    const globalFetch = jest.fn(() => {
      throw new Error('the helper must not use a global fetch');
    });
    const previous = host.fetch;
    host.fetch = globalFetch;
    try {
      const post = postTransport(() => ({ ok: true, status: 204 }));
      await uploadReceiptBinary(POST_AUTH, FILE, post.transport);
      const put = xhrTransport({ status: 200 });
      await uploadReceiptBinary(PUT_AUTH, FILE, put.transport);

      expect(globalFetch).not.toHaveBeenCalled();
      expect(post.calls).toHaveLength(1);
      expect(put.calls).toHaveLength(1);
    } finally {
      host.fetch = previous;
    }
  });

  it('logs nothing at all, on success or on failure', async () => {
    // A signed URL, policy or header must never reach a log sink.
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (level) => jest.spyOn(console, level).mockImplementation(() => undefined),
    );
    try {
      await uploadReceiptBinary(
        POST_AUTH,
        FILE,
        postTransport(() => ({ ok: true, status: 204 })).transport,
      );
      await uploadReceiptBinary(
        POST_AUTH,
        FILE,
        postTransport(() => ({ ok: false, status: 403 })).transport,
      ).catch(() => undefined);
      await uploadReceiptBinary(
        PUT_AUTH,
        FILE,
        xhrTransport({ status: 500 }).transport,
      ).catch(() => undefined);

      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
