package com.mansar.driver.location

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Native UUIDv7 generation, on the JVM.
 *
 * `sample_id` is what makes ingestion idempotent, so the value has to be a
 * genuinely valid v7 UUID — the API validates it against the repository's
 * UUID-v7 pattern and will reject anything else with a 400 before the service
 * is reached.
 */
class UuidV7Test {

  /** The same shape the API's `UUID_V7_PATTERN` enforces. */
  private val canonicalV7 =
    Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

  @Test
  fun `generates canonical version 7 text accepted by the API pattern`() {
    repeat(500) {
      val text = UuidV7.generate().toString()
      assertTrue("not canonical v7: $text", canonicalV7.matches(text))
    }
  }

  @Test
  fun `sets the version nibble to 7`() {
    repeat(500) {
      val uuid = UuidV7.generate()
      assertEquals(7, uuid.version())
      // Read positionally too, not only through the JDK accessor.
      assertEquals('7', uuid.toString()[14])
    }
  }

  @Test
  fun `sets the RFC variant`() {
    repeat(500) {
      val uuid = UuidV7.generate()
      assertEquals(2, uuid.variant())
      assertTrue("89ab".contains(uuid.toString()[19]))
    }
  }

  @Test
  fun `is unique across a meaningful sample set`() {
    val count = 10_000
    val seen = HashSet<String>(count * 2)
    repeat(count) { seen.add(UuidV7.generate().toString()) }
    assertEquals(count, seen.size)
  }

  @Test
  fun `carries the generation time in its timestamp portion`() {
    val before = System.currentTimeMillis()
    val uuid = UuidV7.generate()
    val after = System.currentTimeMillis()

    val stamped = UuidV7.timestampMillis(uuid)
    assertTrue("$stamped < $before", stamped >= before)
    assertTrue("$stamped > $after", stamped <= after)
  }

  @Test
  fun `round-trips an explicit timestamp exactly`() {
    // 48 bits of milliseconds reaches well past the year 10000, so a far
    // future value must survive unchanged rather than wrapping.
    for (millis in listOf(0L, 1L, 1_767_225_600_000L, 0xFFFF_FFFF_FFFFL)) {
      assertEquals(millis, UuidV7.timestampMillis(UuidV7.generateAt(millis)))
    }
  }

  @Test
  fun `two values minted in the same millisecond still differ`() {
    // No monotonic ordering is claimed for Stage 8 — ordering is by
    // recorded_at with sample_id only as a tiebreak — but the random bits
    // must still make same-millisecond values distinct.
    val millis = 1_767_225_600_000L
    val seen = HashSet<String>()
    repeat(1_000) { seen.add(UuidV7.generateAt(millis).toString()) }
    assertEquals(1_000, seen.size)
  }

  @Test
  fun `is not derived from any observation or identity`() {
    // Same timestamp, repeated generation: if the value were derived from a
    // coordinate, a trip, a user or recordedAt it would repeat. It does not.
    val millis = 1_767_225_600_000L
    val first = UuidV7.generateAt(millis).toString()
    val second = UuidV7.generateAt(millis).toString()
    assertTrue(first != second)
    // The timestamp prefix is shared; everything after it is random.
    assertEquals(first.substring(0, 13), second.substring(0, 13))
  }
}
