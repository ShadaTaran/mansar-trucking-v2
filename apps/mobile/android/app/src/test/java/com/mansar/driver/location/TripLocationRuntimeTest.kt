package com.mansar.driver.location

import com.mansar.driver.location.TripLocationRuntime.ClaimOutcome
import com.mansar.driver.location.TripLocationRuntime.Session
import com.mansar.driver.location.TripLocationRuntime.TransitionOutcome
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The paused half of the session transition domain, on the JVM.
 *
 * Pause exists for one reason: the trip-completion window needs capture to
 * stop, the queue tail to upload, and the *same* session to carry on if the
 * completion is refused — without surrendering the foreground service and
 * without passing the start gates again. That makes "paused" part of the
 * session rather than a flag beside it, and makes every assertion below a
 * statement about a transition.
 *
 * The class is named for its subject rather than its file because the file
 * name is fixed by the gate and `TripLocationRuntimeTest` already exists in
 * this package, inside `LocationEmissionPolicyTest.kt`, where Stage 8C.1c had
 * to put it when no new path was authorized. Two classes of one name cannot
 * share a package.
 *
 * Synthetic identities only.
 */
class TripLocationRuntimePauseTest {

  private val sessionA = Session(ownerUserId = "owner-a", tripId = "trip-a")
  private val sessionB = Session(ownerUserId = "owner-a", tripId = "trip-b")
  private val otherOwner = Session(ownerUserId = "owner-b", tripId = "trip-a")

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

  /** Whether a capture would be admitted for [session] right now. */
  private fun admits(session: Session): Boolean {
    var ran = false
    val admitted = TripLocationRuntime.captureIfAdmitted(session) { ran = true }
    assertEquals(admitted, ran)
    return admitted
  }

  @Test
  fun `a new claim starts unpaused and admitting`() {
    assertEquals(ClaimOutcome.CLAIMED, TripLocationRuntime.claim(sessionA))
    val snapshot = TripLocationRuntime.snapshot()
    assertEquals(sessionA, snapshot.session)
    assertFalse(snapshot.paused)
    assertTrue(TripLocationRuntime.running)
    assertTrue(admits(sessionA))
  }

  @Test
  fun `pause keeps the session owned and only closes admission`() {
    TripLocationRuntime.claim(sessionA)
    assertEquals(TransitionOutcome.CHANGED, TripLocationRuntime.pause(sessionA))

    val snapshot = TripLocationRuntime.snapshot()
    // Owner and trip survive, which is the whole point: the foreground
    // service keeps a session to belong to.
    assertEquals(sessionA, snapshot.session)
    assertEquals("owner-a", snapshot.session?.ownerUserId)
    assertEquals("trip-a", snapshot.session?.tripId)
    assertTrue(snapshot.paused)
    assertTrue(TripLocationRuntime.running)
    assertEquals(sessionA, TripLocationRuntime.active)
    assertFalse(admits(sessionA))
  }

  @Test
  fun `pause is idempotent`() {
    TripLocationRuntime.claim(sessionA)
    assertEquals(TransitionOutcome.CHANGED, TripLocationRuntime.pause(sessionA))
    assertEquals(
      TransitionOutcome.UNCHANGED,
      TripLocationRuntime.pause(sessionA),
    )
    assertEquals(
      TransitionOutcome.UNCHANGED,
      TripLocationRuntime.pause(sessionA),
    )
    assertTrue(TripLocationRuntime.snapshot().paused)
    assertEquals(sessionA, TripLocationRuntime.active)
  }

  @Test
  fun `resume reopens admission for the same session`() {
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.pause(sessionA)
    assertFalse(admits(sessionA))

    assertEquals(TransitionOutcome.CHANGED, TripLocationRuntime.resume(sessionA))

    val snapshot = TripLocationRuntime.snapshot()
    assertEquals(sessionA, snapshot.session)
    assertFalse(snapshot.paused)
    assertTrue(admits(sessionA))
  }

  @Test
  fun `resume is idempotent`() {
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.pause(sessionA)
    assertEquals(TransitionOutcome.CHANGED, TripLocationRuntime.resume(sessionA))
    assertEquals(
      TransitionOutcome.UNCHANGED,
      TripLocationRuntime.resume(sessionA),
    )
    assertEquals(sessionA, TripLocationRuntime.active)
    assertTrue(admits(sessionA))
  }

  @Test
  fun `a pause for a different trip or owner changes nothing`() {
    TripLocationRuntime.claim(sessionA)
    for (other in listOf(sessionB, otherOwner)) {
      assertEquals(TransitionOutcome.BUSY, TripLocationRuntime.pause(other))
      val snapshot = TripLocationRuntime.snapshot()
      assertEquals(sessionA, snapshot.session)
      assertFalse(snapshot.paused)
      assertTrue(admits(sessionA))
    }
  }

  @Test
  fun `a resume for a different trip or owner changes nothing`() {
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.pause(sessionA)
    for (other in listOf(sessionB, otherOwner)) {
      assertEquals(TransitionOutcome.BUSY, TripLocationRuntime.resume(other))
      val snapshot = TripLocationRuntime.snapshot()
      // Still A, still paused: a stale resume cannot reopen somebody else.
      assertEquals(sessionA, snapshot.session)
      assertTrue(snapshot.paused)
      assertFalse(admits(sessionA))
    }
  }

  @Test
  fun `pause and resume with nothing running are no-ops`() {
    assertEquals(
      TransitionOutcome.NOT_RUNNING,
      TripLocationRuntime.pause(sessionA),
    )
    assertEquals(
      TransitionOutcome.NOT_RUNNING,
      TripLocationRuntime.resume(sessionA),
    )
    // No session was fabricated to make the call succeed.
    val snapshot = TripLocationRuntime.snapshot()
    assertNull(snapshot.session)
    assertFalse(snapshot.paused)
  }

  @Test
  fun `the stop transition clears both the session and the pause`() {
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.pause(sessionA)

    assertEquals(sessionA, TripLocationRuntime.endActive {})

    val snapshot = TripLocationRuntime.snapshot()
    assertNull(snapshot.session)
    assertFalse(snapshot.paused)
    assertFalse(admits(sessionA))
  }

  @Test
  fun `ending a paused session clears the pause`() {
    // The service's onDestroy path: conditional end, from paused.
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.pause(sessionA)
    assertTrue(TripLocationRuntime.endIfActive(sessionA))

    val snapshot = TripLocationRuntime.snapshot()
    assertNull(snapshot.session)
    assertFalse(snapshot.paused)
  }

  @Test
  fun `a claim after a paused session was stopped starts unpaused`() {
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.pause(sessionA)
    TripLocationRuntime.endActive {}

    assertEquals(ClaimOutcome.CLAIMED, TripLocationRuntime.claim(sessionB))
    val snapshot = TripLocationRuntime.snapshot()
    assertEquals(sessionB, snapshot.session)
    // A pause never inherits to the next session.
    assertFalse(snapshot.paused)
    assertTrue(admits(sessionB))
  }

  @Test
  fun `a delayed resume cannot resurrect a stopped session`() {
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.pause(sessionA)
    TripLocationRuntime.endActive {}

    assertEquals(
      TransitionOutcome.NOT_RUNNING,
      TripLocationRuntime.resume(sessionA),
    )
    assertNull(TripLocationRuntime.active)
    assertFalse(admits(sessionA))
  }

  @Test
  fun `a delayed resume cannot reopen a replacement session`() {
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.pause(sessionA)
    TripLocationRuntime.endActive {}
    TripLocationRuntime.claim(sessionB)
    TripLocationRuntime.pause(sessionB)

    assertEquals(TransitionOutcome.BUSY, TripLocationRuntime.resume(sessionA))
    val snapshot = TripLocationRuntime.snapshot()
    assertEquals(sessionB, snapshot.session)
    assertTrue(snapshot.paused)
    assertFalse(admits(sessionB))
  }

  @Test
  fun `an identity-sensitive end stops the exact paused session`() {
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.pause(sessionA)

    // The service-destruction path: the instance holds the exact object it was
    // promoted for, and a paused session holds no callback to find it by.
    assertTrue(TripLocationRuntime.endIfOwnedInstance(sessionA))

    val snapshot = TripLocationRuntime.snapshot()
    assertNull(snapshot.session)
    assertFalse(snapshot.paused)
    assertFalse(admits(sessionA))
  }

  @Test
  fun `an identity-sensitive end refuses an equal session from another object`() {
    val first = Session(ownerUserId = "owner-a", tripId = "trip-a")
    val second = Session(ownerUserId = "owner-a", tripId = "trip-a")
    // Equal by value, distinct objects: exactly what a stop-then-start of the
    // same trip produces, and exactly what value equality cannot tell apart.
    assertEquals(first, second)
    assertFalse(first === second)

    TripLocationRuntime.claim(first)
    var ran = false
    assertFalse(TripLocationRuntime.endIfOwnedInstance(second) { ran = true })
    assertFalse(ran)

    // The live session is untouched and still capturing.
    val snapshot = TripLocationRuntime.snapshot()
    assertTrue(snapshot.session === first)
    assertFalse(snapshot.paused)
    assertTrue(TripLocationRuntime.running)
    assertTrue(admits(first))

    // And the instance that really owns it can still end it.
    var teardown = 0
    assertTrue(TripLocationRuntime.endIfOwnedInstance(first) { teardown += 1 })
    assertEquals(1, teardown)
    assertNull(TripLocationRuntime.active)
    assertFalse(TripLocationRuntime.snapshot().paused)
  }

  @Test
  fun `value and identity teardown differ deliberately`() {
    val first = Session(ownerUserId = "owner-a", tripId = "trip-a")
    val second = Session(ownerUserId = "owner-a", tripId = "trip-a")
    TripLocationRuntime.claim(first)

    // The value primitive accepts an equal session, which is right for the
    // module's own start-failure path; the identity one does not, which is
    // right for a dying service.
    assertFalse(TripLocationRuntime.endIfOwnedInstance(second))
    assertTrue(TripLocationRuntime.endIfActive(second))
    assertNull(TripLocationRuntime.active)
  }

  @Test
  fun `a generation-sensitive resume refuses an equal session from another object`() {
    val first = Session(ownerUserId = "owner-a", tripId = "trip-a")
    val second = Session(ownerUserId = "owner-a", tripId = "trip-a")
    assertEquals(first, second)
    assertFalse(first === second)

    TripLocationRuntime.claim(first)
    TripLocationRuntime.pause(first)

    // A provider registration started for `second` must not unpause `first`
    // just because the two name the same owner and trip.
    assertEquals(
      TransitionOutcome.BUSY,
      TripLocationRuntime.resumeIfOwnedInstance(second),
    )
    val stillPaused = TripLocationRuntime.snapshot()
    assertTrue(stillPaused.session === first)
    assertTrue(stillPaused.paused)
    assertFalse(admits(first))

    // The generation that actually registered may reopen admission.
    assertEquals(
      TransitionOutcome.CHANGED,
      TripLocationRuntime.resumeIfOwnedInstance(first),
    )
    val active = TripLocationRuntime.snapshot()
    assertTrue(active.session === first)
    assertFalse(active.paused)
    assertTrue(admits(first))
  }

  @Test
  fun `a generation-sensitive resume cannot unpause an equal-valued successor`() {
    val first = Session(ownerUserId = "owner-a", tripId = "trip-a")
    val second = Session(ownerUserId = "owner-a", tripId = "trip-a")

    TripLocationRuntime.claim(first)
    TripLocationRuntime.pause(first)
    TripLocationRuntime.endActive {}
    TripLocationRuntime.claim(second)
    TripLocationRuntime.pause(second)
    TripLocationRuntime.recordError(TripLocationErrors.START_FAILED)

    // The predecessor's late registration success arrives now.
    assertEquals(
      TransitionOutcome.BUSY,
      TripLocationRuntime.resumeIfOwnedInstance(first),
    )
    val snapshot = TripLocationRuntime.snapshot()
    assertTrue(snapshot.session === second)
    assertTrue(snapshot.paused)
    assertFalse(admits(second))
    assertEquals(TripLocationErrors.START_FAILED, TripLocationRuntime.lastError())
  }

  @Test
  fun `a generation-sensitive resume reports nothing running and no change`() {
    assertEquals(
      TransitionOutcome.NOT_RUNNING,
      TripLocationRuntime.resumeIfOwnedInstance(sessionA),
    )
    assertNull(TripLocationRuntime.active)

    TripLocationRuntime.claim(sessionA)
    // Active already: idempotent, not an error.
    assertEquals(
      TransitionOutcome.UNCHANGED,
      TripLocationRuntime.resumeIfOwnedInstance(sessionA),
    )
    assertTrue(admits(sessionA))
  }

  @Test
  fun `value and generation resume differ deliberately`() {
    val first = Session(ownerUserId = "owner-a", tripId = "trip-a")
    val second = Session(ownerUserId = "owner-a", tripId = "trip-a")
    TripLocationRuntime.claim(first)
    TripLocationRuntime.pause(first)

    // The value primitive accepts an equal session, which is how a bridge
    // request authorized by owner and trip resumes the trip the driver is
    // looking at; the generation one does not, which is what an asynchronous
    // provider registration needs.
    assertEquals(
      TransitionOutcome.BUSY,
      TripLocationRuntime.resumeIfOwnedInstance(second),
    )
    assertEquals(TransitionOutcome.CHANGED, TripLocationRuntime.resume(second))
    assertFalse(TripLocationRuntime.snapshot().paused)
  }

  @Test
  fun `an identity-sensitive end with nothing running is a no-op`() {
    var ran = false
    assertFalse(TripLocationRuntime.endIfOwnedInstance(sessionA) { ran = true })
    assertFalse(ran)
    assertNull(TripLocationRuntime.active)
    assertFalse(TripLocationRuntime.snapshot().paused)
  }

  @Test
  fun `exact-generation attribution records the code for the current session`() {
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.pause(sessionA)

    assertEquals(
      TransitionOutcome.UNCHANGED,
      TripLocationRuntime.recordErrorIfOwnedInstance(
        sessionA,
        TripLocationErrors.PERMISSION_REQUIRED,
      ),
    )

    assertEquals(
      TripLocationErrors.PERMISSION_REQUIRED,
      TripLocationRuntime.lastError(),
    )
    // Attributing a failure is not a lifecycle transition: the session is the
    // same object, still paused, and admission is not reopened.
    val snapshot = TripLocationRuntime.snapshot()
    assertTrue(snapshot.session === sessionA)
    assertTrue(snapshot.paused)
    assertFalse(admits(sessionA))
  }

  @Test
  fun `exact-generation attribution cannot overwrite an equal-valued successor`() {
    val first = Session(ownerUserId = "owner-a", tripId = "trip-a")
    val second = Session(ownerUserId = "owner-a", tripId = "trip-a")
    assertEquals(first, second)
    assertFalse(first === second)

    TripLocationRuntime.claim(first)
    TripLocationRuntime.pause(first)
    TripLocationRuntime.endActive {}
    TripLocationRuntime.claim(second)
    TripLocationRuntime.pause(second)
    TripLocationRuntime.recordError(TripLocationErrors.QUEUE_ERROR)

    // The predecessor's synchronous refusal is attributed now. It must not
    // land on the successor merely because the two name the same trip.
    assertEquals(
      TransitionOutcome.BUSY,
      TripLocationRuntime.recordErrorIfOwnedInstance(
        first,
        TripLocationErrors.PERMISSION_REQUIRED,
      ),
    )

    assertEquals(TripLocationErrors.QUEUE_ERROR, TripLocationRuntime.lastError())
    val snapshot = TripLocationRuntime.snapshot()
    assertTrue(snapshot.session === second)
    assertTrue(snapshot.paused)

    // The generation that actually failed may still record its own code.
    assertEquals(
      TransitionOutcome.UNCHANGED,
      TripLocationRuntime.recordErrorIfOwnedInstance(
        second,
        TripLocationErrors.PERMISSION_REQUIRED,
      ),
    )
    assertEquals(
      TripLocationErrors.PERMISSION_REQUIRED,
      TripLocationRuntime.lastError(),
    )
    assertTrue(TripLocationRuntime.snapshot().paused)
  }

  @Test
  fun `exact-generation attribution writes nothing when nothing is running`() {
    TripLocationRuntime.recordError(TripLocationErrors.QUEUE_ERROR)

    assertEquals(
      TransitionOutcome.NOT_RUNNING,
      TripLocationRuntime.recordErrorIfOwnedInstance(
        sessionA,
        TripLocationErrors.START_FAILED,
      ),
    )

    // Unchanged: there is no session for the code to belong to.
    assertEquals(TripLocationErrors.QUEUE_ERROR, TripLocationRuntime.lastError())
    assertNull(TripLocationRuntime.active)
    assertFalse(TripLocationRuntime.snapshot().paused)
  }

  @Test
  fun `exact-generation attribution refuses a stopped generation`() {
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.pause(sessionA)
    TripLocationRuntime.endActive {}
    TripLocationRuntime.recordError(TripLocationErrors.QUEUE_ERROR)

    assertEquals(
      TransitionOutcome.NOT_RUNNING,
      TripLocationRuntime.recordErrorIfOwnedInstance(
        sessionA,
        TripLocationErrors.START_FAILED,
      ),
    )
    assertEquals(TripLocationErrors.QUEUE_ERROR, TripLocationRuntime.lastError())
  }

  @Test
  fun `exact-generation attribution refuses a different trip`() {
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.recordError(TripLocationErrors.QUEUE_ERROR)

    assertEquals(
      TransitionOutcome.BUSY,
      TripLocationRuntime.recordErrorIfOwnedInstance(
        sessionB,
        TripLocationErrors.START_FAILED,
      ),
    )
    assertEquals(TripLocationErrors.QUEUE_ERROR, TripLocationRuntime.lastError())
    assertTrue(TripLocationRuntime.snapshot().session === sessionA)
  }

  @Test
  fun `pause waits for a capture that was already admitted`() {
    TripLocationRuntime.claim(sessionA)
    val order = ConcurrentLinkedQueue<String>()
    val insideCapture = CountDownLatch(1)
    val releaseCapture = CountDownLatch(1)
    val pauseReturned = CountDownLatch(1)

    val capturing =
      Thread {
        TripLocationRuntime.captureIfAdmitted(sessionA) {
          insideCapture.countDown()
          // Standing in for the filter, the minted id and the insert.
          releaseCapture.await()
          order.add("row")
        }
      }
    capturing.start()
    assertTrue(insideCapture.await(5, TimeUnit.SECONDS))

    val pausing =
      Thread {
        TripLocationRuntime.pause(sessionA)
        order.add("paused")
        pauseReturned.countDown()
      }
    pausing.start()

    // The pause cannot cut an admitted capture in half: it is still waiting
    // while that capture holds the domain, and nothing has been recorded.
    assertFalse(pauseReturned.await(250, TimeUnit.MILLISECONDS))
    assertNull(order.peek())

    releaseCapture.countDown()
    capturing.join()
    assertTrue(pauseReturned.await(5, TimeUnit.SECONDS))
    pausing.join()

    assertEquals(listOf("row", "paused"), order.toList())
  }

  @Test
  fun `no capture is admitted once pause has returned`() {
    TripLocationRuntime.claim(sessionA)
    assertTrue(admits(sessionA))

    assertEquals(TransitionOutcome.CHANGED, TripLocationRuntime.pause(sessionA))

    // The guarantee the completion window depends on: after pause returns, no
    // later fix for that session can reach SQLite until a resume.
    var late = 0
    for (attempt in 1..5) {
      if (TripLocationRuntime.captureIfAdmitted(sessionA) { late += 1 }) {
        late += 1000
      }
    }
    assertEquals(0, late)

    TripLocationRuntime.resume(sessionA)
    assertTrue(admits(sessionA))
  }

  @Test
  fun `concurrent pauses leave exactly one transition and a paused session`() {
    TripLocationRuntime.claim(sessionA)
    val go = CountDownLatch(1)
    val outcomes = ConcurrentLinkedQueue<TransitionOutcome>()
    val threads =
      (1..8).map {
        Thread {
          go.await()
          outcomes.add(TripLocationRuntime.pause(sessionA))
        }
      }
    threads.forEach { it.start() }
    go.countDown()
    threads.forEach { it.join() }

    assertEquals(1, outcomes.count { it == TransitionOutcome.CHANGED })
    assertEquals(7, outcomes.count { it == TransitionOutcome.UNCHANGED })
    assertTrue(TripLocationRuntime.snapshot().paused)
    assertFalse(admits(sessionA))
  }

  @Test
  fun `a paused session still reports its own last error code`() {
    TripLocationRuntime.claim(sessionA)
    TripLocationRuntime.pause(sessionA)
    TripLocationRuntime.recordError(TripLocationErrors.START_FAILED)
    // Pausing does not clear operational state, and the code survives a
    // resume so the caller can still see why a restore failed earlier.
    assertEquals(TripLocationErrors.START_FAILED, TripLocationRuntime.lastError())
    TripLocationRuntime.resume(sessionA)
    assertEquals(TripLocationErrors.START_FAILED, TripLocationRuntime.lastError())
  }
}
