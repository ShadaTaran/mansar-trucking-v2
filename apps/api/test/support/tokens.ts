/**
 * Test fixture: the same length and alphabet as a real refresh token, but the
 * final character carries non-zero unused bits, so it is not the canonical
 * encoding of any 32 bytes. The last of 43 characters encodes only two data
 * bits, and 'B' (index 1) has its low bits set.
 */
export function noncanonicalVariant(token: string): string {
  return `${token.slice(0, -1)}B`;
}
