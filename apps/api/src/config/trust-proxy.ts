/**
 * TRUST_PROXY_HOPS: how many reverse-proxy hops in front of the API may be
 * trusted for client-IP resolution (Express `trust proxy`). 0 (default) trusts
 * none, which is correct for local development. Deployments set it to the
 * verified number of hops in their topology; no provider is assumed here.
 */
export const TRUST_PROXY_HOPS_MAX = 10;

export function parseTrustProxyHops(value: string | undefined): number {
  if (value === undefined || value === '') {
    return 0;
  }
  if (!/^(0|[1-9][0-9]?)$/.test(value)) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 10');
  }
  const hops = Number(value);
  if (hops > TRUST_PROXY_HOPS_MAX) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 10');
  }
  return hops;
}
