package com.mansar.driver.location

import android.content.Context
import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Wakes JavaScript for one bounded location-queue drain.
 *
 * Stage 8E measured the gap this closes. Native capture kept writing fixes for
 * half an hour with the Activity away, and all of them reached the server in
 * the same second — the moment the app came back. The queue was fine; the
 * JavaScript that uploads it was not running, because React Native suspends the
 * runtime with the Activity and no JS timer survives that.
 *
 * So [TripLocationService] asks for this service every sixty seconds while it
 * is capturing, and Android starts the JS runtime long enough to run the
 * `MansarLocationDrain` task. That is the whole purpose: an errand, not a
 * service. It is not a foreground service, it posts no notification of its own,
 * and it holds nothing between invocations.
 *
 * Authentication stays in JavaScript, which is the point of doing it this way.
 * This class carries one string — the owner's user id — so the task knows whose
 * rows were meant, and the JS side rechecks that hint against the session
 * before reading anything. No access token, no refresh token, no coordinate, no
 * sample id and no queue content is ever put in an Intent, in task data or in a
 * log line here: an Intent is a place a credential would outlive the request
 * that needed it.
 */
class TripLocationDrainService : HeadlessJsTaskService() {

  /**
   * Describes the task for one start, or refuses it.
   *
   * Null means Android ends the service without starting the runtime, which is
   * the right answer to a start with no owner behind it: a task that does not
   * know whose rows it is draining has nothing it may read.
   */
  protected override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val owner = intent?.getStringExtra(EXTRA_OWNER_USER_ID)
    if (owner.isNullOrEmpty()) {
      return null
    }
    val data = Arguments.createMap().apply { putString(DATA_OWNER_USER_ID, owner) }
    return HeadlessJsTaskConfig(
      TASK_KEY,
      data,
      TASK_TIMEOUT_MILLIS,
      ALLOWED_IN_FOREGROUND,
    )
  }

  companion object {
    /**
     * The registered task name, matching `AppRegistry.registerHeadlessTask` in
     * `index.js` exactly. A mismatch does not fail loudly — the task simply
     * never runs — so these two strings are the one thing to keep in step.
     */
    const val TASK_KEY = "MansarLocationDrain"

    /** The single Intent extra: whose queue, and nothing else. */
    const val EXTRA_OWNER_USER_ID = "ownerUserId"

    /** The matching key inside the task data handed to JavaScript. */
    const val DATA_OWNER_USER_ID = "ownerUserId"

    /**
     * How long Android lets one task run before terminating it.
     *
     * Above the JS side's own thirty-second budget, deliberately: the task is
     * expected to finish by its own decision, and this is the backstop for the
     * case where it cannot. Fifteen seconds of headroom covers a pass that
     * began just under the budget and then sat on the ten-second request
     * deadline.
     */
    const val TASK_TIMEOUT_MILLIS = 45_000L

    /**
     * Allowed to run while the app counts as foreground.
     *
     * Not an optimisation — a correctness requirement. The kick comes from a
     * *location foreground service*, so from Android's point of view this app
     * is frequently foreground exactly when the Activity is not. Refusing to
     * run in the foreground would make the task throw `IllegalStateException`
     * on precisely the device state this mechanism exists for. Running it while
     * the app really is in front of the driver is harmless: the task joins the
     * one shared drain rather than starting a second one.
     */
    const val ALLOWED_IN_FOREGROUND = true

    /** The Intent one kick sends; the owner id is its only payload. */
    fun intent(context: Context, ownerUserId: String): Intent =
      Intent(context, TripLocationDrainService::class.java)
        .putExtra(EXTRA_OWNER_USER_ID, ownerUserId)
  }
}
