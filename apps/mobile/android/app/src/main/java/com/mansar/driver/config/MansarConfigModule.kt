package com.mansar.driver.config

import com.facebook.react.bridge.ReactApplicationContext
import com.mansar.driver.BuildConfig
import com.mansar.driver.specs.NativeMansarConfigSpec

/**
 * Exposes the build-time API endpoint to JavaScript. The value comes only
 * from the Gradle build type (BuildConfig.MANSAR_API_BASE_URL); it is not a
 * secret and cannot be changed at runtime. Nothing else is exposed.
 */
class MansarConfigModule(reactContext: ReactApplicationContext) :
  NativeMansarConfigSpec(reactContext) {

  override fun getName(): String = NAME

  override fun getTypedExportedConstants(): Map<String, Any?> =
    mapOf("apiBaseUrl" to BuildConfig.MANSAR_API_BASE_URL)

  companion object {
    const val NAME = "MansarConfig"
  }
}
