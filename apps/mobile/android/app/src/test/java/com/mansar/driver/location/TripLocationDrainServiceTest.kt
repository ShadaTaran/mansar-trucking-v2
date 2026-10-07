package com.mansar.driver.location

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The background-drain errand's frozen configuration, on the JVM.
 *
 * Every value here is one that fails *silently* when it drifts. A task key
 * that does not match `AppRegistry.registerHeadlessTask` means Android starts
 * the runtime and then runs nothing; `isAllowedInForeground = false` means the
 * task throws on exactly the device state this mechanism exists for, because
 * the kick comes from a location foreground service; a missing `WAKE_LOCK`
 * means the task cannot start at all. None of those produce a failing
 * assertion anywhere else, and none of them are visible in the app's UI — the
 * only symptom is a queue that quietly stops draining in the background, which
 * is the defect Stage 8E found in the first place.
 *
 * There is no Robolectric and no mocking framework in this module, so an
 * Android `Service` cannot be instantiated and a real `Intent` cannot be read.
 * What can be checked without a device is checked here: the constants, which
 * Kotlin inlines from the production source, the manifest, and the parts of
 * the kick that are statements about *which API is called* rather than about
 * behaviour. Behaviour belongs to the device proof.
 */
class TripLocationDrainServiceTest {

  /**
   * Finds a module file whatever directory Gradle chose to run tests from.
   *
   * Walks up from the working directory and also tries an `app/` child, so
   * the test is correct from the module directory and from the Android project
   * root alike.
   */
  private fun moduleFile(relative: String): File {
    var dir: File? = File("").absoluteFile
    while (dir != null) {
      File(dir, relative).let { if (it.isFile) return it }
      File(dir, "app/$relative").let { if (it.isFile) return it }
      dir = dir.parentFile
    }
    throw AssertionError("could not locate $relative from ${File("").absolutePath}")
  }

  /**
   * Kotlin source with its comments removed.
   *
   * These files explain at length which APIs they deliberately do *not* use,
   * so a search of the raw text finds `WorkManager` and
   * `startForegroundService` in prose that says they are forbidden. Only the
   * code may answer a question about the code.
   */
  private fun String.code(): String =
    replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), "")
      .replace(Regex("//[^\n]*"), "")

  /** XML with its comments removed, for the same reason. */
  private fun String.xml(): String =
    replace(Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL), "")

  private val manifest: String by lazy {
    moduleFile("src/main/AndroidManifest.xml").readText()
  }

  private val kickSource: String by lazy {
    moduleFile(
      "src/main/java/com/mansar/driver/location/TripLocationService.kt",
    )
      .readText()
  }

  private val drainSource: String by lazy {
    moduleFile(
      "src/main/java/com/mansar/driver/location/TripLocationDrainService.kt",
    )
      .readText()
  }

  // ---------------------------------------------------------------- task

  @Test
  fun `task key matches the JavaScript registration exactly`() {
    assertEquals("MansarLocationDrain", TripLocationDrainService.TASK_KEY)
  }

  @Test
  fun `task timeout is the frozen forty-five seconds`() {
    // Above the JS side's own thirty-second budget: the task is meant to stop
    // by its own decision, and this is only the backstop.
    assertEquals(45_000L, TripLocationDrainService.TASK_TIMEOUT_MILLIS)
    assertTrue(
      TripLocationDrainService.TASK_TIMEOUT_MILLIS > 30_000L,
    )
  }

  @Test
  fun `task is allowed to run while the app counts as foreground`() {
    // A location foreground service makes this app foreground precisely when
    // the Activity is not; refusing would throw on that state.
    assertTrue(TripLocationDrainService.ALLOWED_IN_FOREGROUND)
  }

  @Test
  fun `the task carries an owner id and nothing else`() {
    assertEquals("ownerUserId", TripLocationDrainService.EXTRA_OWNER_USER_ID)
    assertEquals("ownerUserId", TripLocationDrainService.DATA_OWNER_USER_ID)
    // One `putExtra`, and one key put into the task data.
    assertEquals(1, Regex("putExtra\\(").findAll(drainSource).count())
    assertEquals(1, Regex("putString\\(").findAll(drainSource).count())
  }

  @Test
  fun `no credential or observation is named anywhere in the service`() {
    for (forbidden in
      listOf(
        "accessToken",
        "refreshToken",
        "Authorization",
        "bearer",
        "Bearer",
        "latitude",
        "longitude",
        "sampleId",
      )) {
      assertFalse(forbidden, drainSource.contains(forbidden))
    }
  }

  @Test
  fun `the drain service never promotes itself to the foreground`() {
    // A second persistent notification is exactly what an errand must not
    // owe Android.
    assertFalse(drainSource.code().contains("startForeground"))
  }

  // ---------------------------------------------------------------- kick

  @Test
  fun `the native kick interval is the frozen sixty seconds`() {
    assertEquals(60_000L, TripLocationService.DRAIN_KICK_INTERVAL_MILLIS)
  }

  @Test
  fun `the kick uses startService and never startForegroundService`() {
    val code = kickSource.code()
    assertTrue(code.contains("startService("))
    // The only `startForegroundService` in this file is the compat promotion
    // of the *capture* service, which predates this stage. The kick must not
    // add a bare one: it would demand a notification within five seconds from
    // a service that has none to show.
    val all = Regex("startForegroundService\\(").findAll(code).count()
    val compat =
      Regex("ContextCompat\\.startForegroundService\\(").findAll(code).count()
    assertEquals(1, compat)
    assertEquals(compat, all)
  }

  @Test
  fun `the kick chain is cancelled on pause, failure and destruction`() {
    val code = kickSource.code()
    // One declaration and three call sites, and those three are the three
    // ways capture stops admitting: a pause, a provider failure that ends the
    // session, and destruction.
    assertEquals(
      1,
      Regex("fun cancelDrainKicks\\(\\)").findAll(code).count(),
    )
    assertEquals(4, Regex("cancelDrainKicks\\(\\)").findAll(code).count())
    val destroy = code.indexOf("override fun onDestroy()")
    assertTrue(destroy > 0)
    assertTrue(code.indexOf("cancelDrainKicks()", destroy) > destroy)
    val pause = code.indexOf("private fun pauseSession(")
    assertTrue(pause > 0)
    assertTrue(code.indexOf("cancelDrainKicks()", pause) > pause)
  }

  @Test
  fun `no alarm, work manager or boot receiver stands behind the kick`() {
    for (forbidden in
      listOf(
        "AlarmManager",
        "WorkManager",
        "BOOT_COMPLETED",
        "setExactAndAllowWhileIdle",
      )) {
      assertFalse(forbidden, kickSource.code().contains(forbidden))
    }
  }

  @Test
  fun `the capture service stays explicitly non-sticky`() {
    assertTrue(kickSource.code().contains("START_NOT_STICKY"))
  }

  // ------------------------------------------------------------ manifest

  @Test
  fun `the manifest declares WAKE_LOCK`() {
    // React Native's HeadlessJsTaskService acquires a PARTIAL_WAKE_LOCK for
    // the lifetime of every task; without this the task throws on start.
    assertTrue(
      manifest
        .xml()
        .contains(
          """<uses-permission android:name="android.permission.WAKE_LOCK" />""",
        ),
    )
  }

  @Test
  fun `the manifest still does not declare background location`() {
    // Asserted as a *declaration*, not as a string: the manifest explains in
    // a comment why this permission is absent, and that comment must not be
    // able to satisfy the check.
    assertFalse(
      manifest
        .xml()
        .contains(
          """<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION"""",
        ),
    )
  }

  @Test
  fun `the manifest keeps the existing location permissions unchanged`() {
    for (permission in
      listOf(
        "android.permission.INTERNET",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_LOCATION",
        "android.permission.POST_NOTIFICATIONS",
      )) {
      assertTrue(
        permission,
        manifest.contains("""<uses-permission android:name="$permission" />"""),
      )
    }
  }

  @Test
  fun `the drain service is declared and not exported`() {
    val declared = manifest.xml()
    val declaration = declared.substringAfter(".location.TripLocationDrainService")
    assertTrue(declared.contains(".location.TripLocationDrainService"))
    // Nothing outside this app may start it.
    assertTrue(
      declaration.substringBefore("/>").contains("""android:exported="false""""),
    )
    // No foreground service type: it is not one.
    assertFalse(
      declaration.substringBefore("/>").contains("foregroundServiceType"),
    )
  }

  @Test
  fun `the capture service is still the only location foreground service`() {
    assertEquals(
      1,
      Regex("foregroundServiceType=\"location\"")
        .findAll(manifest.xml())
        .count(),
    )
  }
}
