/**
 * Transport-neutral HTTP core of the Mansar API client.
 *
 * Nothing here knows about React, React Native, Next or Nest (ADR 0001).
 * The `fetch` implementation is injected (defaulting to the global one), the
 * base URL is configuration, and every failure becomes an `ApiError` whose
 * message is a fixed string: no request body, header, token or response text
 * is ever copied into an error.
 */

/** Minimal request shape the client sends; a subset of the Fetch `RequestInit`. */
export interface HttpRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Minimal response shape the client reads; satisfied by the Fetch `Response`. */
export interface HttpResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: HttpRequest,
) => Promise<HttpResponse>;

export interface ApiClientConfig {
  /** Absolute base URL of the Mansar API, without a trailing slash. */
  readonly baseUrl: string;
  /** Transport; defaults to the global `fetch` of the host platform. */
  readonly fetch: FetchLike;
}

export interface ApiClientOptions {
  readonly fetch?: FetchLike;
}

/**
 * Normalises a base URL so path joining is predictable and binds the
 * transport. `fetch` is resolved lazily from `globalThis` when not supplied,
 * so importing this package never touches platform globals.
 */
export function createApiClientConfig(
  baseUrl: string,
  options: ApiClientOptions = {},
): ApiClientConfig {
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    fetch: options.fetch ?? globalFetch,
  };
}

function globalFetch(url: string, init: HttpRequest): Promise<HttpResponse> {
  const candidate: unknown = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== 'function') {
    return Promise.reject(
      new ApiError('network', { detail: 'fetch is not available' }),
    );
  }
  // Called through globalThis so browser-style implementations keep `this`.
  return (candidate as FetchLike).call(globalThis, url, init);
}

/** Why a request failed; the HTTP status and code are available for `http`. */
export type ApiErrorKind = 'http' | 'network' | 'invalid_response';

/** Server error codes the API documents (the `message` field of its error body). */
export const API_ERROR_CODES = [
  'invalid_credentials',
  'account_inactive',
  'invalid_refresh_token',
  'unauthorized',
  'forbidden',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

// Codes are short lower-snake identifiers. Anything else in `message` (Nest
// validation issues, unexpected text) is dropped rather than echoed.
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly kind: ApiErrorKind;
  /** HTTP status for `http` failures, otherwise null. */
  readonly status: number | null;
  /** The API's error code when the body carried a well-formed one. */
  readonly code: string | null;

  constructor(
    kind: ApiErrorKind,
    details: { status?: number; code?: string | null; detail?: string } = {},
  ) {
    super(describe(kind, details.detail));
    this.kind = kind;
    this.status = details.status ?? null;
    this.code = details.code ?? null;
  }

  /** True for a documented code, narrowing `code` for callers. */
  hasCode(code: ApiErrorCode): boolean {
    return this.kind === 'http' && this.code === code;
  }
}

function describe(kind: ApiErrorKind, detail: string | undefined): string {
  const base =
    kind === 'http'
      ? 'api request failed'
      : kind === 'network'
        ? 'api request could not be sent'
        : 'api response was not in the expected shape';
  return detail ? `${base}: ${detail}` : base;
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export interface RequestSpec {
  readonly method: 'GET' | 'POST';
  /** Path relative to the base URL, starting with `/`. */
  readonly path: string;
  /** JSON-serialised as the request body. */
  readonly body?: unknown;
  /** Sent as `Authorization: Bearer <token>`; never placed anywhere else. */
  readonly accessToken?: string;
}

interface RawResult {
  readonly status: number;
  readonly text: string;
}

async function send(
  config: ApiClientConfig,
  spec: RequestSpec,
): Promise<RawResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (spec.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (spec.accessToken !== undefined) {
    headers.authorization = `Bearer ${spec.accessToken}`;
  }
  const init: HttpRequest = {
    method: spec.method,
    headers,
    ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
  };

  let response: HttpResponse;
  try {
    response = await config.fetch(config.baseUrl + spec.path, init);
  } catch {
    throw new ApiError('network');
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ApiError('network');
  }
  return { status: response.status, text };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorCodeOf(text: string): string | null {
  const body = parseJson(text);
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' && ERROR_CODE_PATTERN.test(message)
    ? message
    : null;
}

function throwHttpError(result: RawResult): never {
  throw new ApiError('http', {
    status: result.status,
    code: errorCodeOf(result.text),
  });
}

/**
 * Performs a request expecting a 200 JSON body; `parse` returns null for
 * anything that is not the documented shape, which is reported as an
 * `invalid_response` failure instead of being trusted.
 */
export async function requestJson<T>(
  config: ApiClientConfig,
  spec: RequestSpec,
  parse: (value: unknown) => T | null,
): Promise<T> {
  const result = await send(config, spec);
  if (result.status !== 200) {
    throwHttpError(result);
  }
  const body = parseJson(result.text);
  const parsed = body === undefined ? null : parse(body);
  if (parsed === null) {
    throw new ApiError('invalid_response', { status: result.status });
  }
  return parsed;
}

/**
 * Performs a request expecting a **201** JSON body, for an endpoint whose
 * contract is "created" rather than "here is the current state".
 *
 * Deliberately a sibling of `requestJson` rather than a status parameter on
 * it. The expected status *is* part of the contract — the driver expense
 * create answers 201 and nothing else — so a caller that asked for the
 * created variant and got a 200 was answered by something other than the
 * endpoint it meant to call, and should hear about it rather than have the
 * body quietly accepted. Keeping it separate also leaves `requestJson` and
 * `requestNoContent` exactly as they are: both already have call sites across
 * the workspace, and widening either to take a status would change every one
 * of them for the benefit of this single new case.
 *
 * Everything else is shared with `requestJson`: the same `send`, the same
 * JSON parsing, the same HTTP error shaping and the same fail-closed parser
 * contract, so a malformed 201 body is an `invalid_response` and is never
 * trusted.
 */
export async function requestCreated<T>(
  config: ApiClientConfig,
  spec: RequestSpec,
  parse: (value: unknown) => T | null,
): Promise<T> {
  const result = await send(config, spec);
  if (result.status !== 201) {
    throwHttpError(result);
  }
  const body = parseJson(result.text);
  const parsed = body === undefined ? null : parse(body);
  if (parsed === null) {
    throw new ApiError('invalid_response', { status: result.status });
  }
  return parsed;
}

/** Performs a request expecting 204 No Content. */
export async function requestNoContent(
  config: ApiClientConfig,
  spec: RequestSpec,
): Promise<void> {
  const result = await send(config, spec);
  if (result.status !== 204) {
    throwHttpError(result);
  }
}
