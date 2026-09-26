import {
  pickReceiptFile,
  RECEIPT_CONTENT_TYPES,
  RECEIPT_MAX_BYTE_SIZE,
  RECEIPT_MIN_BYTE_SIZE,
  ReceiptPickError,
  receiptPickMessage,
} from './receipt-picker';

const { __receiptPickerFake: picker } = jest.requireMock<
  typeof import('../specs/__mocks__/NativeReceiptPicker')
>('../specs/NativeReceiptPicker');

const URI = 'content://media/external/images/media/1234';

const FILE = {
  uri: URI,
  contentType: 'image/jpeg',
  byteSize: 2048,
};

beforeEach(() => {
  picker.reset();
});

describe('receipt picker contract', () => {
  it('states the frozen type set and size window', () => {
    expect(RECEIPT_CONTENT_TYPES).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
    expect(RECEIPT_MIN_BYTE_SIZE).toBe(1);
    expect(RECEIPT_MAX_BYTE_SIZE).toBe(10 * 1024 * 1024);
  });

  it('returns the local file shape and nothing else', async () => {
    picker.resolveFile(FILE);
    const file = await pickReceiptFile();
    expect(file).toEqual(FILE);
    expect(Object.keys(file ?? {}).sort()).toEqual([
      'byteSize',
      'contentType',
      'uri',
    ]);
    // No filename is produced, because none is needed or wanted.
    expect(file).not.toHaveProperty('name');
    expect(file).not.toHaveProperty('fileName');
  });

  it.each(RECEIPT_CONTENT_TYPES)('accepts a %s image', async (contentType) => {
    picker.resolveFile({ ...FILE, contentType });
    await expect(pickReceiptFile()).resolves.toMatchObject({ contentType });
  });

  it.each([
    ['the smallest allowed size', RECEIPT_MIN_BYTE_SIZE],
    ['a typical photo', 2_000_000],
    ['exactly the ceiling', RECEIPT_MAX_BYTE_SIZE],
  ])('accepts %s', async (_label, byteSize) => {
    picker.resolveFile({ ...FILE, byteSize });
    await expect(pickReceiptFile()).resolves.toMatchObject({ byteSize });
  });
});

describe('cancellation', () => {
  it('resolves null when the driver cancelled', async () => {
    picker.resolveCancelled();
    await expect(pickReceiptFile()).resolves.toBeNull();
  });

  it('treats a null file field as cancellation, not an error', async () => {
    picker.resolveRaw({ file: null });
    await expect(pickReceiptFile()).resolves.toBeNull();
  });

  it('treats only an explicit null as cancellation, never undefined', async () => {
    // `{file: null}` is the shape the native module emits via putNull.
    // `{file: undefined}` is a key that exists but carries nothing, which no
    // working module produces, so it must not read as a dismissal.
    picker.resolveRaw({ file: null });
    await expect(pickReceiptFile()).resolves.toBeNull();

    picker.resolveRaw({ file: undefined });
    const error = (await pickReceiptFile().catch(
      (e: unknown) => e,
    )) as ReceiptPickError;
    expect(error).toBeInstanceOf(ReceiptPickError);
    expect(error.code).toBe('receipt_pick_failed');
  });

  it('asks the native module exactly once per pick', async () => {
    picker.resolveCancelled();
    await pickReceiptFile();
    expect(picker.calls).toBe(1);
  });
});

describe('unsupported images are refused locally', () => {
  it.each([
    ['HEIC', 'image/heic'],
    ['HEIF', 'image/heif'],
    ['GIF', 'image/gif'],
    ['BMP', 'image/bmp'],
    ['TIFF', 'image/tiff'],
    ['SVG', 'image/svg+xml'],
    ['a PDF', 'application/pdf'],
    ['an upper-case JPEG', 'IMAGE/JPEG'],
    ['a parameterised JPEG', 'image/jpeg; charset=utf-8'],
    ['a padded JPEG', ' image/jpeg '],
    ['an empty type', ''],
  ])(
    'rejects %s before any authorization is requested',
    async (_l, contentType) => {
      picker.resolveFile({ ...FILE, contentType });
      const error = (await pickReceiptFile().catch(
        (e: unknown) => e,
      )) as ReceiptPickError;
      expect(error).toBeInstanceOf(ReceiptPickError);
      expect(error.code).toBe('receipt_type_unsupported');
      expect(receiptPickMessage(error)).toBe(
        'Receipts must be a JPEG, PNG or WebP image. Choose another.',
      );
    },
  );

  it('treats a missing MIME type as unreadable rather than unsupported', async () => {
    // The platform exposes MIME for picker results; guessing one from a
    // filename extension is exactly what must not happen.
    picker.resolveFile({ uri: URI, byteSize: 2048 });
    const error = (await pickReceiptFile().catch(
      (e: unknown) => e,
    )) as ReceiptPickError;
    expect(error.code).toBe('receipt_pick_failed');
  });

  it('treats a null MIME type as unreadable', async () => {
    picker.resolveFile({ ...FILE, contentType: null });
    const error = (await pickReceiptFile().catch(
      (e: unknown) => e,
    )) as ReceiptPickError;
    expect(error.code).toBe('receipt_pick_failed');
  });
});

describe('size validation', () => {
  it('rejects an empty image', async () => {
    picker.resolveFile({ ...FILE, byteSize: 0 });
    const error = (await pickReceiptFile().catch(
      (e: unknown) => e,
    )) as ReceiptPickError;
    expect(error.code).toBe('receipt_empty');
    expect(receiptPickMessage(error)).toBe(
      'That image is empty. Choose another.',
    );
  });

  it('rejects one byte over the ceiling', async () => {
    picker.resolveFile({ ...FILE, byteSize: RECEIPT_MAX_BYTE_SIZE + 1 });
    const error = (await pickReceiptFile().catch(
      (e: unknown) => e,
    )) as ReceiptPickError;
    expect(error.code).toBe('receipt_too_large');
    expect(receiptPickMessage(error)).toBe(
      'That image is larger than 10 MB. Choose a smaller one.',
    );
  });

  it.each([
    ['a negative size', -1],
    ['a string size', '2048'],
    ['a fractional size', 2048.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a missing size', undefined],
    ['a null size', null],
  ])('rejects %s', async (_label, byteSize) => {
    picker.resolveFile({ ...FILE, byteSize });
    const error = (await pickReceiptFile().catch(
      (e: unknown) => e,
    )) as ReceiptPickError;
    expect(error).toBeInstanceOf(ReceiptPickError);
    // A negative integer is empty; everything else is unreadable metadata.
    expect(['receipt_empty', 'receipt_pick_failed']).toContain(error.code);
  });
});

describe('URI validation', () => {
  it.each([
    ['an empty URI', ''],
    ['a bare path', '/storage/emulated/0/Pictures/receipt.jpg'],
    ['a file URI', 'file:///storage/emulated/0/receipt.jpg'],
    ['an http URI', 'http://example.test/receipt.jpg'],
    ['an https URI', 'https://example.test/receipt.jpg'],
    ['a data URI', 'data:image/jpeg;base64,AAAA'],
    ['a numeric URI', 42],
    ['a null URI', null],
    ['a missing URI', undefined],
  ])('rejects %s', async (_label, uri) => {
    // Only a local content URI is a picker result. An http(s) body would
    // make the native layer *download* the file, which is not a selection.
    picker.resolveFile({ ...FILE, uri });
    const error = (await pickReceiptFile().catch(
      (e: unknown) => e,
    )) as ReceiptPickError;
    expect(error.code).toBe('receipt_pick_failed');
  });
});

describe('fail-closed handling of the native module', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'content://media/1'],
    ['a number', 1],
    ['an array', []],
    ['an object with no file key', { picked: {} }],
    ['a file that is undefined', { file: undefined }],
    ['a file that is a string', { file: 'content://media/1' }],
    ['a file that is an array', { file: [] }],
    ['a file that is a number', { file: 7 }],
  ])(
    'treats %s as a failure rather than a selection',
    async (_label, value) => {
      picker.resolveRaw(value);
      const error = (await pickReceiptFile().catch(
        (e: unknown) => e,
      )) as ReceiptPickError;
      expect(error).toBeInstanceOf(ReceiptPickError);
      expect(error.code).toBe('receipt_pick_failed');
    },
  );

  it('maps a native rejection to the fixed local code', async () => {
    picker.reject(new Error('receipt_pick_failed'));
    const error = (await pickReceiptFile().catch(
      (e: unknown) => e,
    )) as ReceiptPickError;
    expect(error).toBeInstanceOf(ReceiptPickError);
    expect(error.code).toBe('receipt_pick_failed');
  });

  it('discards whatever the native rejection carried', async () => {
    // Even if the native side ever regressed and included detail, it cannot
    // reach a screen through this boundary.
    picker.reject(
      new Error(
        'failed to open content://media/external/images/media/9 (EACCES)',
      ),
    );
    const error = (await pickReceiptFile().catch(
      (e: unknown) => e,
    )) as ReceiptPickError;
    expect(error.message).toBe('receipt_pick_failed');
    expect(error.message).not.toContain('content://');
    expect(error.message).not.toContain('EACCES');
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(
      'media/9',
    );
  });

  it('returns null from receiptPickMessage for an unrelated error', async () => {
    expect(receiptPickMessage(new Error('something else'))).toBeNull();
    expect(receiptPickMessage(null)).toBeNull();
  });
});
