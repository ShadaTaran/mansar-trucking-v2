package com.mansar.driver.location

/**
 * Decides which captured fixes become queued samples.
 *
 * Pure and stateless apart from the last emitted fix, so the whole capture
 * policy is testable on the JVM without an Android device, a provider or a
 * database. The service owns one instance and consults it per callback.
 *
 * Three rules, in order:
 *
 * 1. **Usable.** A fix with a non-finite or out-of-range coordinate is not a
 *    position and is discarded. A fix coarser than [MAX_ACCURACY_METRES] is
 *    discarded too, because a kilometre-scale "position" is not a truck's
 *    location. The decision is made per fix on the accuracy the device
 *    reported, never on which permission was granted. Exactly 100 m is
 *    usable; 100.000001 m is not.
 * 2. **First fix.** The first usable fix is always emitted, so a freshly
 *    started trip shows a position immediately rather than after a wait.
 * 3. **Displacement or heartbeat.** Afterwards a fix is emitted when it is at
 *    least [MIN_DISPLACEMENT_METRES] from the last emitted one, **or** when
 *    [HEARTBEAT_MILLIS] of elapsed time has passed. The heartbeat is what
 *    keeps a stationary truck distinguishable from an offline one: without it,
 *    displacement filtering would make "parked" and "app died" look the same.
 *
 * The heartbeat is measured on **monotonic elapsed time**, not wall clock.
 * A device whose clock jumps — a network time sync, a manual change, a
 * timezone-driven correction — must not thereby appear to have waited five
 * minutes, or to have waited none. `recordedAt` still comes from the fix's
 * wall clock, because that is the fact the server stores; the two uses are
 * deliberately different.
 *
 * Nothing here mutates state. The service calls [accept] only once a queue
 * write has actually succeeded, so a failed write cannot suppress the next
 * usable fix — losing one sample to a database error must not also lose the
 * five minutes behind it.
 */
class LocationEmissionPolicy {

  /** A fix as the policy sees it, already extracted from the platform object. */
  data class Fix(
    val latitude: Double,
    val longitude: Double,
    /** Metres, or null when the device reported no accuracy. */
    val accuracyMetres: Double?,
    /** Monotonic elapsed time, for the heartbeat only. */
    val elapsedRealtimeMillis: Long,
  )

  /** Why a fix was not emitted, or that it was. */
  sealed interface Decision {
    /** Queue this fix, then call [accept]. */
    data object Emit : Decision

    /** The fix is not a usable position at all. */
    data object Unusable : Decision

    /** Usable, but too close to the last emitted fix and not yet due. */
    data object Suppressed : Decision
  }

  private var lastLatitude: Double = 0.0
  private var lastLongitude: Double = 0.0
  private var lastElapsedRealtimeMillis: Long = 0L
  private var hasEmitted: Boolean = false

  /** Whether this fix should become a queued sample. */
  fun decide(fix: Fix): Decision {
    if (!isUsable(fix)) {
      return Decision.Unusable
    }
    if (!hasEmitted) {
      return Decision.Emit
    }
    val movedEnough =
      distanceMetres(lastLatitude, lastLongitude, fix.latitude, fix.longitude) >=
        MIN_DISPLACEMENT_METRES
    val heartbeatDue =
      fix.elapsedRealtimeMillis - lastElapsedRealtimeMillis >= HEARTBEAT_MILLIS
    return if (movedEnough || heartbeatDue) Decision.Emit else Decision.Suppressed
  }

  /**
   * Records [fix] as the last emitted one.
   *
   * Called only after the queue write succeeded. Calling it on a write failure
   * would restart the heartbeat for a sample that was never stored.
   */
  fun accept(fix: Fix) {
    lastLatitude = fix.latitude
    lastLongitude = fix.longitude
    lastElapsedRealtimeMillis = fix.elapsedRealtimeMillis
    hasEmitted = true
  }

  /** Forgets the last emitted fix, so the next usable one emits immediately. */
  fun reset() {
    hasEmitted = false
    lastLatitude = 0.0
    lastLongitude = 0.0
    lastElapsedRealtimeMillis = 0L
  }

  private fun isUsable(fix: Fix): Boolean {
    if (!fix.latitude.isFinite() || fix.latitude < -90.0 || fix.latitude > 90.0) {
      return false
    }
    if (!fix.longitude.isFinite() || fix.longitude < -180.0 || fix.longitude > 180.0) {
      return false
    }
    val accuracy = fix.accuracyMetres ?: return true
    if (!accuracy.isFinite() || accuracy < 0.0) {
      return false
    }
    return accuracy <= MAX_ACCURACY_METRES
  }

  companion object {
    /** Coarser than this is not a truck position (metres). */
    const val MAX_ACCURACY_METRES: Double = 100.0

    /** Suppresses a stationary vehicle's jitter (metres). */
    const val MIN_DISPLACEMENT_METRES: Double = 25.0

    /** Keeps "stopped" distinguishable from "offline" (milliseconds). */
    const val HEARTBEAT_MILLIS: Long = 5 * 60 * 1000L

    private const val EARTH_RADIUS_METRES = 6_371_008.8

    /**
     * Great-circle distance by the haversine formula.
     *
     * Accurate to well under a metre at the 25 m scale this decides, which is
     * all it has to be: the question is "has the truck moved a bus length",
     * not "how far exactly". Exposed for the unit tests.
     */
    fun distanceMetres(
      fromLatitude: Double,
      fromLongitude: Double,
      toLatitude: Double,
      toLongitude: Double,
    ): Double {
      val deltaLatitude = Math.toRadians(toLatitude - fromLatitude)
      val deltaLongitude = Math.toRadians(toLongitude - fromLongitude)
      val fromLatitudeRadians = Math.toRadians(fromLatitude)
      val toLatitudeRadians = Math.toRadians(toLatitude)
      val a =
        Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
          Math.cos(fromLatitudeRadians) *
            Math.cos(toLatitudeRadians) *
            Math.sin(deltaLongitude / 2) *
            Math.sin(deltaLongitude / 2)
      return 2 * EARTH_RADIUS_METRES * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    }
  }
}
