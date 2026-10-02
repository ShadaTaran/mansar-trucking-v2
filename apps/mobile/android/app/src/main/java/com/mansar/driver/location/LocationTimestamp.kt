package com.mansar.driver.location

import java.util.Locale
import java.util.TimeZone
import java.text.SimpleDateFormat

/**
 * Formats a location fix's wall-clock capture instant for `recordedAt`.
 *
 * The value is the time the fix was *observed*, taken from the fix itself —
 * never the time the queue write finished, the time the upload happened, or
 * anything resembling the server's `receivedAt`. Those are different facts,
 * and conflating them is exactly what ADR 0011 separates.
 *
 * The output is fixed-width on purpose:
 * ```
 *   YYYY-MM-DDTHH:mm:ss.SSSZ      2026-10-01T03:45:12.037Z
 * ```
 * always UTC, always exactly three fractional digits, `.000` included. The
 * SQLite queue orders by `recorded_at` as **text**, so a variable-width form
 * would sort wrongly: `…12Z` would land before `…12.100Z` on a lexicographic
 * comparison even though it is the earlier instant by only a fraction. A
 * fixed width makes the text order the instant order.
 *
 * `SimpleDateFormat` is not thread-safe, so a new instance is created per
 * call. These are low-frequency calls — at most one per emitted sample, so one
 * every 30 seconds at the fastest — and a fresh formatter is cheaper than
 * reasoning about a shared mutable one on the service's worker thread.
 */
object LocationTimestamp {

  private const val PATTERN = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"

  /** [unixTimeMillis] as a UTC ISO 8601 instant with three millis digits. */
  fun format(unixTimeMillis: Long): String {
    val formatter = SimpleDateFormat(PATTERN, Locale.US)
    formatter.timeZone = TimeZone.getTimeZone("UTC")
    return formatter.format(java.util.Date(unixTimeMillis))
  }
}
