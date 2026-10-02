package com.mansar.driver.location

import java.util.TimeZone
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * `recordedAt` formatting, on the JVM.
 *
 * The fixed width matters beyond tidiness: the SQLite queue orders by
 * `recorded_at` as text, so a variable number of fractional digits would sort
 * the wrong way. `…12Z` precedes `…12.100Z` lexicographically even though it
 * is the earlier instant by only a fraction, and a drain that reordered
 * samples would upload a path out of sequence.
 */
class LocationTimestampTest {

  private val canonical = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")
  private lateinit var original: TimeZone

  @Before
  fun captureDefaultZone() {
    original = TimeZone.getDefault()
  }

  @After
  fun restoreDefaultZone() {
    TimeZone.setDefault(original)
  }

  @Test
  fun `formats a whole second with three zero millis digits`() {
    // 2026-10-01T03:45:12.000Z
    assertEquals("2026-10-01T03:45:12.000Z", LocationTimestamp.format(1_790_826_312_000L))
  }

  @Test
  fun `preserves non-zero milliseconds`() {
    assertEquals("2026-10-01T03:45:12.037Z", LocationTimestamp.format(1_790_826_312_037L))
    assertEquals("2026-10-01T03:45:12.100Z", LocationTimestamp.format(1_790_826_312_100L))
    assertEquals("2026-10-01T03:45:12.999Z", LocationTimestamp.format(1_790_826_312_999L))
  }

  @Test
  fun `always emits exactly three fractional digits and a Z suffix`() {
    for (offset in listOf(0L, 1L, 10L, 100L, 999L, 1_000L, 86_399_999L)) {
      val formatted = LocationTimestamp.format(1_790_826_312_000L + offset)
      assertTrue("not canonical: $formatted", canonical.matches(formatted))
      assertTrue(formatted.endsWith("Z"))
      assertEquals(24, formatted.length)
    }
  }

  @Test
  fun `is UTC regardless of the device timezone`() {
    val millis = 1_790_826_312_037L
    val expected = "2026-10-01T03:45:12.037Z"
    // A phone set to Manila or to Los Angeles must format the same instant
    // identically; the device timezone is never consulted.
    for (zone in listOf("Asia/Manila", "America/Los_Angeles", "UTC", "Pacific/Kiritimati")) {
      TimeZone.setDefault(TimeZone.getTimeZone(zone))
      assertEquals("wrong output under $zone", expected, LocationTimestamp.format(millis))
    }
  }

  @Test
  fun `the epoch formats as the canonical zero instant`() {
    assertEquals("1970-01-01T00:00:00.000Z", LocationTimestamp.format(0L))
  }

  @Test
  fun `fixed width makes text order match instant order`() {
    val earlier = LocationTimestamp.format(1_790_826_312_000L)
    val later = LocationTimestamp.format(1_790_826_312_100L)
    // The property the SQLite ORDER BY depends on.
    assertTrue("$earlier should sort before $later", earlier < later)
    assertEquals(earlier.length, later.length)
  }
}
