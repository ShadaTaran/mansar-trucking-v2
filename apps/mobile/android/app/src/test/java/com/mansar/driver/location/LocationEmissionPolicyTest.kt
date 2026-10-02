package com.mansar.driver.location

import com.mansar.driver.location.TripLocationRuntime.ClaimOutcome
import com.mansar.driver.location.TripLocationRuntime.Session
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * The capture policy, on the JVM.
 *
 * Every rule Stage 8C.1 freezes is decided by [LocationEmissionPolicy] alone,
 * so it can all be proved here without a device, a provider or a database —
 * which is the point of keeping the policy pure.
 *
 * Synthetic coordinates only; the Manila base point is invented.
 */
class LocationEmissionPolicyTest {

  private val baseLatitude = 14.599512
  private val baseLongitude = 120.984222
  private val minute = 60_000L

  private fun fix(
    latitude: Double = baseLatitude,
    longitude: Double = baseLongitude,
    accuracy: Double? = 8.5,
    elapsed: Long = 0L,
  ) =
    LocationEmissionPolicy.Fix(
      latitude = latitude,
      longitude = longitude,
      accuracyMetres = accuracy,
      elapsedRealtimeMillis = elapsed,
    )

  /** Decide, and accept when the decision was to emit, as the service does. */
  private fun LocationEmissionPolicy.offer(
    fix: LocationEmissionPolicy.Fix
  ): LocationEmissionPolicy.Decision {
    val decision = decide(fix)
    if (decision == LocationEmissionPolicy.Decision.Emit) {
      accept(fix)
    }
    return decision
  }

  /**
   * A longitude offset that is [metres] east of the base point.
   *
   * Derived from the policy's own distance function so the test cannot drift
   * from the implementation's idea of a metre.
   */
  private fun longitudeOffsetFor(metres: Double): Double {
    val metresPerDegree =
      LocationEmissionPolicy.distanceMetres(
        baseLatitude,
        baseLongitude,
        baseLatitude,
        baseLongitude + 1.0,
      )
    return baseLongitude + metres / metresPerDegree
  }

  @Test
  fun `first usable fix emits immediately`() {
    val policy = LocationEmissionPolicy()
    assertEquals(LocationEmissionPolicy.Decision.Emit, policy.offer(fix()))
  }

  @Test
  fun `accuracy of exactly 100 metres is usable`() {
    val policy = LocationEmissionPolicy()
    assertEquals(LocationEmissionPolicy.Decision.Emit, policy.offer(fix(accuracy = 100.0)))
  }

  @Test
  fun `accuracy beyond 100 metres is unusable`() {
    val policy = LocationEmissionPolicy()
    assertEquals(
      LocationEmissionPolicy.Decision.Unusable,
      policy.offer(fix(accuracy = 100.000001)),
    )
    // A coarse grant tends to produce fixes like this one. The rule is about
    // the reported accuracy, not the permission: a kilometre-scale "position"
    // is discarded whichever permission produced it.
    assertEquals(LocationEmissionPolicy.Decision.Unusable, policy.offer(fix(accuracy = 3000.0)))
  }

  @Test
  fun `a missing accuracy is usable and is not treated as zero`() {
    val policy = LocationEmissionPolicy()
    assertEquals(LocationEmissionPolicy.Decision.Emit, policy.offer(fix(accuracy = null)))
  }

  @Test
  fun `a negative or non-finite accuracy is unusable`() {
    val policy = LocationEmissionPolicy()
    assertEquals(LocationEmissionPolicy.Decision.Unusable, policy.offer(fix(accuracy = -1.0)))
    assertEquals(
      LocationEmissionPolicy.Decision.Unusable,
      policy.offer(fix(accuracy = Double.NaN)),
    )
    assertEquals(
      LocationEmissionPolicy.Decision.Unusable,
      policy.offer(fix(accuracy = Double.POSITIVE_INFINITY)),
    )
  }

  @Test
  fun `an out-of-range or non-finite coordinate is unusable`() {
    val policy = LocationEmissionPolicy()
    for (latitude in listOf(90.000001, -90.000001, Double.NaN, Double.POSITIVE_INFINITY)) {
      assertEquals(
        LocationEmissionPolicy.Decision.Unusable,
        policy.offer(fix(latitude = latitude)),
      )
    }
    for (longitude in listOf(180.000001, -180.000001, Double.NaN, Double.NEGATIVE_INFINITY)) {
      assertEquals(
        LocationEmissionPolicy.Decision.Unusable,
        policy.offer(fix(longitude = longitude)),
      )
    }
    // None of those advanced the filter, so the poles are still accepted.
    assertEquals(LocationEmissionPolicy.Decision.Emit, policy.offer(fix(latitude = 90.0)))
  }

  @Test
  fun `a stationary truck is suppressed before the heartbeat is due`() {
    val policy = LocationEmissionPolicy()
    policy.offer(fix(elapsed = 0L))
    assertEquals(
      LocationEmissionPolicy.Decision.Suppressed,
      policy.offer(fix(elapsed = 4 * minute)),
    )
    assertEquals(
      LocationEmissionPolicy.Decision.Suppressed,
      policy.offer(fix(elapsed = 5 * minute - 1)),
    )
  }

  @Test
  fun `a stationary truck emits at exactly five minutes`() {
    val policy = LocationEmissionPolicy()
    policy.offer(fix(elapsed = 0L))
    // Zero displacement: the heartbeat alone has to carry this, or "parked"
    // and "offline" would look the same to the admin.
    assertEquals(LocationEmissionPolicy.Decision.Emit, policy.offer(fix(elapsed = 5 * minute)))
  }

  @Test
  fun `movement below 25 metres before the heartbeat is suppressed`() {
    val policy = LocationEmissionPolicy()
    policy.offer(fix(elapsed = 0L))
    assertEquals(
      LocationEmissionPolicy.Decision.Suppressed,
      policy.offer(fix(longitude = longitudeOffsetFor(24.0), elapsed = minute)),
    )
  }

  @Test
  fun `movement of at least 25 metres emits before the heartbeat`() {
    val policy = LocationEmissionPolicy()
    policy.offer(fix(elapsed = 0L))
    assertEquals(
      LocationEmissionPolicy.Decision.Emit,
      policy.offer(fix(longitude = longitudeOffsetFor(26.0), elapsed = minute)),
    )
  }

  @Test
  fun `the heartbeat is measured on the monotonic input, not the wall clock`() {
    // Two policies, identical except for the monotonic value. Only the
    // monotonic clock may decide the heartbeat: a device whose wall clock
    // jumps forward must not thereby appear to have waited five minutes.
    val jumped = LocationEmissionPolicy()
    jumped.offer(fix(elapsed = 0L))
    // Monotonic time barely moved, so no heartbeat is due however far a wall
    // clock may have travelled — the policy is never given a wall clock.
    assertEquals(
      LocationEmissionPolicy.Decision.Suppressed,
      jumped.offer(fix(elapsed = 1_000L)),
    )

    val waited = LocationEmissionPolicy()
    waited.offer(fix(elapsed = 0L))
    assertEquals(LocationEmissionPolicy.Decision.Emit, waited.offer(fix(elapsed = 5 * minute)))

    // The policy's Fix carries no wall-clock field at all, which is what makes
    // the mistake unavailable rather than merely avoided.
    val fields = LocationEmissionPolicy.Fix::class.java.declaredFields.map { it.name }
    assertTrue(fields.contains("elapsedRealtimeMillis"))
    assertTrue(fields.none { it.contains("wall", ignoreCase = true) })
    assertTrue(fields.none { it.contains("recordedAt", ignoreCase = true) })
  }

  @Test
  fun `the heartbeat restarts from the last emitted fix`() {
    val policy = LocationEmissionPolicy()
    policy.offer(fix(elapsed = 0L))
    assertEquals(LocationEmissionPolicy.Decision.Emit, policy.offer(fix(elapsed = 5 * minute)))
    // Four minutes after the second emission, not nine after the first.
    assertEquals(
      LocationEmissionPolicy.Decision.Suppressed,
      policy.offer(fix(elapsed = 9 * minute)),
    )
    assertEquals(LocationEmissionPolicy.Decision.Emit, policy.offer(fix(elapsed = 10 * minute)))
  }

  @Test
  fun `a decision alone does not advance the filter`() {
    // The service calls accept() only after the queue write succeeds, so a
    // failed write must not suppress the next usable fix.
    val policy = LocationEmissionPolicy()
    policy.offer(fix(elapsed = 0L))
    // Decide without accepting: this is the failed-write path.
    assertEquals(LocationEmissionPolicy.Decision.Emit, policy.decide(fix(elapsed = 5 * minute)))
    // The heartbeat is still measured from the first emission, so the very
    // next fix is still due rather than suppressed for another five minutes.
    assertEquals(
      LocationEmissionPolicy.Decision.Emit,
      policy.decide(fix(elapsed = 5 * minute + 1_000L)),
    )
  }

  @Test
  fun `reset makes the next usable fix emit immediately`() {
    val policy = LocationEmissionPolicy()
    policy.offer(fix(elapsed = 0L))
    assertEquals(LocationEmissionPolicy.Decision.Suppressed, policy.offer(fix(elapsed = minute)))
    policy.reset()
    assertEquals(LocationEmissionPolicy.Decision.Emit, policy.offer(fix(elapsed = minute)))
  }

  @Test
  fun `the frozen thresholds are what the policy actually uses`() {
    assertEquals(100.0, LocationEmissionPolicy.MAX_ACCURACY_METRES, 0.0)
    assertEquals(25.0, LocationEmissionPolicy.MIN_DISPLACEMENT_METRES, 0.0)
    assertEquals(5 * minute, LocationEmissionPolicy.HEARTBEAT_MILLIS)
  }

  @Test
  fun `distance is measured in metres across the 25 metre scale`() {
    val twentyFive =
      LocationEmissionPolicy.distanceMetres(
        baseLatitude,
        baseLongitude,
        baseLatitude,
        longitudeOffsetFor(25.0),
      )
    assertEquals(25.0, twentyFive, 0.1)
    assertEquals(
      0.0,
      LocationEmissionPolicy.distanceMetres(
        baseLatitude,
        baseLongitude,
        baseLatitude,
        baseLongitude,
      ),
      0.0,
    )
    assertNotEquals(
      0.0,
      LocationEmissionPolicy.distanceMetres(baseLatitude, baseLongitude, -33.8688, 151.2093),
    )
  }
}

/**
 * The session transition domain, on the JVM.
 *
 * [TripLocationRuntime] is pure Kotlin — no Android type, no provider, no
 * database — so the interleavings Stage 8C.1c closes can be demonstrated here
 * rather than only argued. They are the kind of defect prose is worst at: each
 * one is a race, which is cheap to assert and expensive to reason about.
 *
 * This class shares a file deliberately. The gate authorizes no twentieth
 * repository path and allows extra JVM assertions in an existing Stage 8C.1
 * test file; these belong in a file of their own and should move to one as
 * soon as a gate opens a path for it.
 *
 * Synthetic identities only; no real login or trip id appears here.
 */
class TripLocationRuntimeTest {

  private val sessionA = Session(ownerUserId = "owner-a", tripId = "trip-a")
  private val sessionB = Session(ownerUserId = "owner-a", tripId = "trip-b")

  /** The runtime is a process-wide singleton, so every test starts stopped. */
  @Before
  fun begin() {
    clearRuntime()
  }

  @After
  fun end() {
    clearRuntime()
  }

  private fun clearRuntime() {
    TripLocationRuntime.endActive {}
    TripLocationRuntime.clearError()
  }

  @Test
  fun `claim tells a new session from the identical one and from a different one`() {
    assertEquals(ClaimOutcome.CLAIMED, TripLocationRuntime.claim(sessionA))
    assertEquals(ClaimOutcome.ALREADY_ACTIVE, TripLocationRuntime.claim(sessionA))
    assertEquals(ClaimOutcome.BUSY, TripLocationRuntime.claim(sessionB))
    assertEquals(sessionA, TripLocationRuntime.active)
  }

  @Test
  fun `simultaneous identical claims produce exactly one CLAIMED`() {
    val contenders = 8
    val go = CountDownLatch(1)
    val outcomes = ConcurrentLinkedQueue<ClaimOutcome>()
    val threads =
      (1..contenders).map {
        Thread {
          go.await()
          outcomes.add(TripLocationRuntime.claim(sessionA))
        }
      }
    threads.forEach { it.start() }
    go.countDown()
    threads.forEach { it.join() }

    // Whatever the interleaving: one caller starts the service and the rest
    // are told it is already theirs. Never two services for one session.
    assertEquals(1, outcomes.count { it == ClaimOutcome.CLAIMED })
    assertEquals(contenders - 1, outcomes.count { it == ClaimOutcome.ALREADY_ACTIVE })
    assertEquals(sessionA, TripLocationRuntime.active)
  }

  @Test
  fun `a late failure for a replaced session cannot tear down the live one`() {
    // A ended, B took over, and only now does A's asynchronous registration
    // failure arrive. Everything destructive sits inside the teardown, so
    // proving the teardown never runs proves all of it at once.
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.endIfActive(sessionA)
    TripLocationRuntime.claim(sessionB)
    TripLocationRuntime.recordError(TripLocationErrors.QUEUE_ERROR)

    var cleanedUp = false
    val admitted = TripLocationRuntime.endIfActive(sessionA) { cleanedUp = true }

    assertFalse(admitted)
    assertFalse(cleanedUp)
    assertEquals(sessionB, TripLocationRuntime.active)
    assertEquals(TripLocationErrors.QUEUE_ERROR, TripLocationRuntime.lastError())
  }

  @Test
  fun `a failure for the current session ends it and runs its cleanup once`() {
    TripLocationRuntime.claim(sessionA)
    val steps = mutableListOf<String>()
    val admitted =
      TripLocationRuntime.endIfActive(sessionA) {
        TripLocationRuntime.recordError(TripLocationErrors.START_FAILED)
        steps.add("cleanup")
      }

    assertTrue(admitted)
    assertEquals(listOf("cleanup"), steps)
    assertNull(TripLocationRuntime.active)
    assertEquals(TripLocationErrors.START_FAILED, TripLocationRuntime.lastError())
  }

  @Test
  fun `the stop transition ends the session that was active and nothing else`() {
    // Nothing active: no teardown, so no service stop is requested and a
    // session claimed a moment later cannot be the one that gets stopped.
    assertNull(TripLocationRuntime.endActive { fail("no session was active") })

    TripLocationRuntime.claim(sessionA)
    val stoppedFor = mutableListOf<Session>()
    assertEquals(sessionA, TripLocationRuntime.endActive { stoppedFor.add(it) })
    assertEquals(listOf(sessionA), stoppedFor)
    assertNull(TripLocationRuntime.active)
  }

  @Test
  fun `capture is admitted only for the session that is active`() {
    TripLocationRuntime.claim(sessionA)
    var captured = 0
    assertTrue(TripLocationRuntime.runIfActive(sessionA) { captured++ })
    assertFalse(TripLocationRuntime.runIfActive(sessionB) { captured++ })
    assertEquals(1, captured)
  }

  @Test
  fun `no capture is admitted once the session has ended`() {
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.endActive {}
    var captured = 0
    assertFalse(TripLocationRuntime.runIfActive(sessionA) { captured++ })
    assertEquals(0, captured)
  }

  @Test
  fun `an admitted capture finishes before a concurrent stop and none follows it`() {
    TripLocationRuntime.claim(sessionA)
    val order = ConcurrentLinkedQueue<String>()
    val insideCapture = CountDownLatch(1)
    val releaseCapture = CountDownLatch(1)
    val stopReturned = CountDownLatch(1)

    val capturing =
      Thread {
        TripLocationRuntime.runIfActive(sessionA) {
          insideCapture.countDown()
          // Standing in for the filter, the minted id and the insert.
          releaseCapture.await()
          order.add("row")
        }
      }
    capturing.start()
    assertTrue(insideCapture.await(5, TimeUnit.SECONDS))

    val stopping =
      Thread {
        TripLocationRuntime.endActive { order.add("stop") }
        stopReturned.countDown()
      }
    stopping.start()

    // The stop cannot land in the middle of an admitted capture: it is still
    // waiting while the capture holds the domain, and nothing has been
    // recorded in either direction.
    assertFalse(stopReturned.await(250, TimeUnit.MILLISECONDS))
    assertNull(order.peek())

    releaseCapture.countDown()
    capturing.join()
    assertTrue(stopReturned.await(5, TimeUnit.SECONDS))
    stopping.join()

    assertEquals(listOf("row", "stop"), order.toList())

    // And once the stop has completed, that same callback is refused: this is
    // the invariant the service relies on — no row after the release.
    var late = false
    assertFalse(TripLocationRuntime.runIfActive(sessionA) { late = true })
    assertFalse(late)
  }

  @Test
  fun `a start request claimed before a stop completes is never issued after it`() {
    assertEquals(ClaimOutcome.CLAIMED, TripLocationRuntime.claim(sessionA))
    var cleared = 0
    var started = 0

    // The stop lands in the window between CLAIMED and start admission: the
    // caller has been told it owns the session but has not yet entered the
    // transition that issues the request.
    assertEquals(sessionA, TripLocationRuntime.endActive {})

    // The caller resumes and asks to be admitted.
    val admitted =
      TripLocationRuntime.runIfActive(sessionA) {
        cleared++
        started++
      }

    assertFalse(admitted)
    assertEquals(0, cleared)
    assertEquals(0, started)
    assertNull(TripLocationRuntime.active)
  }

  @Test
  fun `an admitted start request is issued before a concurrent stop completes`() {
    TripLocationRuntime.claim(sessionA)
    val order = ConcurrentLinkedQueue<String>()
    val insideStart = CountDownLatch(1)
    val releaseStart = CountDownLatch(1)
    val stopReturned = CountDownLatch(1)

    val starting =
      Thread {
        TripLocationRuntime.runIfActive(sessionA) {
          insideStart.countDown()
          releaseStart.await()
          // Standing in for clearError() and the service start request.
          order.add("start")
        }
      }
    starting.start()
    assertTrue(insideStart.await(5, TimeUnit.SECONDS))

    val stopping =
      Thread {
        TripLocationRuntime.endActive { order.add("stop") }
        stopReturned.countDown()
      }
    stopping.start()

    // The stop cannot complete while the admitted start body holds the domain.
    assertFalse(stopReturned.await(250, TimeUnit.MILLISECONDS))
    assertNull(order.peek())

    releaseStart.countDown()
    starting.join()
    assertTrue(stopReturned.await(5, TimeUnit.SECONDS))
    stopping.join()

    // The stop request is ordered after the start request, never inside it.
    assertEquals(listOf("start", "stop"), order.toList())
  }

  @Test
  fun `a synchronous start failure completes before any replacement is claimed`() {
    TripLocationRuntime.claim(sessionA)
    val order = ConcurrentLinkedQueue<String>()
    val outcomes = ConcurrentLinkedQueue<ClaimOutcome>()
    val insideStart = CountDownLatch(1)
    val releaseStart = CountDownLatch(1)
    val claimReturned = CountDownLatch(1)

    val failing =
      Thread {
        TripLocationRuntime.runIfActive(sessionA) {
          insideStart.countDown()
          releaseStart.await()
          // The synchronous start throw, handled without leaving the domain:
          // the fixed code is recorded and the session ended in one reentrant
          // transition.
          TripLocationRuntime.recordError(TripLocationErrors.START_FAILED)
          TripLocationRuntime.endIfActive(sessionA)
          order.add("A failed")
        }
      }
    failing.start()
    assertTrue(insideStart.await(5, TimeUnit.SECONDS))

    val replacing =
      Thread {
        // Retries as a real caller would. It cannot stop being busy until A's
        // failure transition has released the domain.
        var result = TripLocationRuntime.claim(sessionB)
        while (result == ClaimOutcome.BUSY) {
          Thread.sleep(1)
          result = TripLocationRuntime.claim(sessionB)
        }
        outcomes.add(result)
        order.add("B claimed")
        claimReturned.countDown()
      }
    replacing.start()

    assertFalse(claimReturned.await(250, TimeUnit.MILLISECONDS))
    assertNull(order.peek())

    releaseStart.countDown()
    failing.join()
    assertTrue(claimReturned.await(5, TimeUnit.SECONDS))
    replacing.join()

    // B took ownership only after A's whole failure transition, so A's error
    // write happened while A still owned the session and cannot land on B's.
    assertEquals(listOf("A failed", "B claimed"), order.toList())
    assertEquals(listOf(ClaimOutcome.CLAIMED), outcomes.toList())
    assertEquals(sessionB, TripLocationRuntime.active)
    assertEquals(TripLocationErrors.START_FAILED, TripLocationRuntime.lastError())
  }
}
