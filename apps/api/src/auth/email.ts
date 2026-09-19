/**
 * Canonical login-email form: trimmed, Unicode NFC, lowercased with the
 * locale-independent `toLowerCase`. Applied before creating a user and before
 * looking one up, so the database's `UNIQUE(email)` operates on this form only.
 * Syntax validation is a separate (Stage 3C) concern.
 */
export function normalizeEmail(input: string): string {
  return input.trim().normalize('NFC').toLowerCase();
}
