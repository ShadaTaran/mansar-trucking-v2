/**
 * RECEIPT_STORAGE_*: where receipt binaries live (Stage 6C, ADR 0009).
 *
 * The names are the application's own, not a provider's. Railway delivers a
 * bucket's credentials through variable references, so a deployment maps
 * each reference onto the name below; nothing is copied by hand and no
 * secret is ever written into source.
 *
 * This shape is portable across S3-compatible endpoints, and the
 * `ReceiptStorage` port above it is provider-neutral — but portability of
 * the *configuration* is not portability of every *capability*. Stage 6C's
 * adapter uploads by presigned POST, which the recorded runner-up
 * (Cloudflare R2) does not support, so moving there would mean changing the
 * adapter's upload implementation, not merely these values.
 *
 * There is deliberately no RECEIPT_STORAGE_PROVIDER. Stage 6C has one
 * selected provider and one adapter; choosing an implementation is a
 * composition concern, not dormant runtime branching. A future migration
 * binds a different `ReceiptStorage` implementation rather than flipping a
 * variable (ADR 0009).
 *
 *   RECEIPT_STORAGE_ENDPOINT           S3 API endpoint, HTTPS only
 *   RECEIPT_STORAGE_REGION             S3 region (Railway reports `auto`)
 *   RECEIPT_STORAGE_BUCKET             bucket name for the S3 API
 *   RECEIPT_STORAGE_ACCESS_KEY_ID      secret
 *   RECEIPT_STORAGE_SECRET_ACCESS_KEY  secret
 *
 * Nothing here ever echoes a supplied value. A message that quoted the
 * variable it rejected would print a secret into the boot log the first time
 * someone pasted a malformed key.
 */

export const RECEIPT_STORAGE_VARIABLES = [
  'RECEIPT_STORAGE_ENDPOINT',
  'RECEIPT_STORAGE_REGION',
  'RECEIPT_STORAGE_BUCKET',
  'RECEIPT_STORAGE_ACCESS_KEY_ID',
  'RECEIPT_STORAGE_SECRET_ACCESS_KEY',
] as const;

export type ReceiptStorageVariable = (typeof RECEIPT_STORAGE_VARIABLES)[number];

export interface ReceiptStorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Present means a non-empty value once surrounding whitespace is ignored. */
function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * The configuration, or `null` when receipt storage is not configured at all.
 *
 * `null` is a supported state, not a failure. The real staging bucket is
 * deliberately not created until its own infrastructure gate, so every
 * environment must keep booting with none of these variables set — Stage 6C
 * is a foundation, and nothing is wired into the running application yet.
 *
 * Partial configuration is a different matter and always throws. Five
 * variables of which four are set is not a deployment that "mostly works":
 * it is one that will fail at the first upload, in a request, instead of at
 * boot where it belongs.
 */
export function parseReceiptStorageConfig(
  env: Readonly<Partial<Record<ReceiptStorageVariable, string>>>,
): ReceiptStorageConfig | null {
  const supplied = RECEIPT_STORAGE_VARIABLES.filter((name) =>
    present(env[name]),
  );
  if (supplied.length === 0) {
    return null;
  }
  if (supplied.length !== RECEIPT_STORAGE_VARIABLES.length) {
    const missing = RECEIPT_STORAGE_VARIABLES.filter(
      (name) => !present(env[name]),
    );
    // Names only, never values: one of the missing siblings is a secret.
    throw new Error(
      `receipt storage is partially configured; missing: ${missing.join(', ')}`,
    );
  }

  const endpoint = env.RECEIPT_STORAGE_ENDPOINT!.trim();
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('RECEIPT_STORAGE_ENDPOINT must be an absolute URL');
  }
  if (parsed.protocol !== 'https:') {
    // Receipts are financial records; an upload authorization must never be
    // signed for an endpoint that would carry it in clear text.
    throw new Error('RECEIPT_STORAGE_ENDPOINT must use https');
  }

  return {
    endpoint,
    region: env.RECEIPT_STORAGE_REGION!.trim(),
    bucket: env.RECEIPT_STORAGE_BUCKET!.trim(),
    accessKeyId: env.RECEIPT_STORAGE_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.RECEIPT_STORAGE_SECRET_ACCESS_KEY!.trim(),
  };
}
