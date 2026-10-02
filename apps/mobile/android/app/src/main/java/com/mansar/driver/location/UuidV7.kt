package com.mansar.driver.location

import java.security.SecureRandom
import java.util.UUID

/**
 * UUID version 7 generation for location sample identities (RFC 9562).
 *
 * The device owns `sample_id`: it is what makes ingestion idempotent, so a
 * retried upload of the same observation carries the same identity and the
 * server recognises it rather than storing a second row.
 *
 * Generated in Kotlin rather than JavaScript for two reasons. The id is minted
 * at the moment a fix survives the capture filter, which happens on the
 * service's worker thread with no JS runtime necessarily awake; and Hermes has
 * no dependable `crypto.randomUUID`, so a JS implementation would have meant
 * adding a dependency for something the platform already provides.
 *
 * Layout, 128 bits:
 * ```
 *   unix_ts_ms  48 bits   big-endian milliseconds since the epoch
 *   ver          4 bits   0b0111
 *   rand_a      12 bits   random
 *   var          2 bits   0b10
 *   rand_b      62 bits   random
 * ```
 *
 * The value is derived from the clock and [SecureRandom] alone — never from a
 * coordinate, a trip, a user, a device identifier or `recordedAt`. Deriving it
 * from the observation would make two genuinely distinct captures collide, and
 * deriving it from an identity would leak that identity into a value the
 * server stores and returns.
 *
 * No monotonicity guarantee is made or needed: Stage 8 orders by `recorded_at`
 * and breaks ties on `sample_id`, so two ids minted in the same millisecond
 * may sort either way.
 */
object UuidV7 {

  private const val VERSION_7: Long = 0x7000

  private val random = SecureRandom()

  /** A fresh UUIDv7 stamped with the current epoch milliseconds. */
  fun generate(): UUID = generateAt(System.currentTimeMillis())

  /**
   * A UUIDv7 stamped with [unixTimeMillis]. Exposed for the unit tests, which
   * need a known timestamp to read back out of the value.
   */
  fun generateAt(unixTimeMillis: Long): UUID {
    val bytes = ByteArray(10)
    random.nextBytes(bytes)

    // Top 48 bits: the timestamp. Bits 48..51: the version. Bits 52..63:
    // twelve random bits from the first two random bytes.
    val randA = ((bytes[0].toLong() and 0xFF) shl 4) or ((bytes[1].toLong() and 0xF0) shr 4)
    val mostSignificant =
      ((unixTimeMillis and 0xFFFF_FFFF_FFFFL) shl 16) or VERSION_7 or (randA and 0xFFF)

    // Top 2 bits: the RFC variant, 0b10. Remaining 62 bits: random. Masking
    // then setting bit 63 is the variant, written as a shift rather than as a
    // 0x8000... constant, which Kotlin cannot express as a Long literal.
    var leastSignificant = 0L
    for (index in 2 until 10) {
      leastSignificant = (leastSignificant shl 8) or (bytes[index].toLong() and 0xFF)
    }
    leastSignificant = (leastSignificant and 0x3FFF_FFFF_FFFF_FFFFL) or (1L shl 63)

    return UUID(mostSignificant, leastSignificant)
  }

  /** The 48-bit timestamp a v7 value carries, in epoch milliseconds. */
  fun timestampMillis(uuid: UUID): Long = uuid.mostSignificantBits ushr 16
}
