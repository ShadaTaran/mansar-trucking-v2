package com.mansar.driver.receipts

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.mansar.driver.specs.NativeReceiptPickerSpec
import java.util.concurrent.atomic.AtomicReference

/**
 * Lets the driver choose one local image for a receipt.
 *
 * Deliberately the narrowest capability that can satisfy the flow:
 *
 * - **No permission is declared or requested.** On API 33+ the system photo
 *   picker (`ACTION_PICK_IMAGES`) returns a single item the user chose, and
 *   below that the document picker (`ACTION_OPEN_DOCUMENT`) does the same.
 *   Both grant access to that one item only, so `READ_MEDIA_IMAGES` and the
 *   legacy storage permissions are unnecessary — and asking for them would
 *   buy access to the whole gallery for no benefit.
 * - **No camera.** Capturing an image is a different capability with a
 *   different permission, and Stage 6F does not need it.
 * - **No persisted grant.** The read grant lasts for this foreground flow,
 *   which is all the upload needs, so `takePersistableUriPermission` is not
 *   called and no URI is stored anywhere.
 *
 * Metadata comes from the `ContentResolver`, never from a filename: the MIME
 * type is what the provider reports and the size is `OpenableColumns.SIZE`.
 * A filename is deliberately not returned — it is not receipt metadata and
 * the API has no field for it.
 *
 * Exactly one request may be outstanding. A second call while one is pending
 * is rejected rather than allowed to overwrite the waiting promise, so a
 * promise is never dropped or settled twice.
 *
 * Every rejection is one of the fixed codes below. A URI, file path, or
 * platform exception message is never placed in a rejection, because those
 * cross into JavaScript and from there into logs and screens.
 */
class ReceiptPickerModule(private val reactContext: ReactApplicationContext) :
  NativeReceiptPickerSpec(reactContext), ActivityEventListener {

  /** The one in-flight request, or null. */
  private val pending = AtomicReference<Promise?>(null)

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = NAME

  override fun invalidate() {
    reactContext.removeActivityEventListener(this)
    // A pending promise must not be left unsettled when the module goes away.
    pending.getAndSet(null)?.reject(ERROR_CANCELLED, MESSAGE_CANCELLED)
    super.invalidate()
  }

  override fun pickReceiptImage(promise: Promise) {
    val activity = getCurrentActivity()
    if (activity == null) {
      promise.reject(ERROR_UNAVAILABLE, MESSAGE_UNAVAILABLE)
      return
    }
    // compareAndSet, not a null check: two calls arriving together must not
    // both believe they own the slot.
    if (!pending.compareAndSet(null, promise)) {
      promise.reject(ERROR_BUSY, MESSAGE_BUSY)
      return
    }
    try {
      activity.startActivityForResult(pickerIntent(), REQUEST_CODE)
    } catch (_: Throwable) {
      // The platform message could name a component or path, so it is dropped.
      pending.compareAndSet(promise, null)
      promise.reject(ERROR_UNAVAILABLE, MESSAGE_UNAVAILABLE)
    }
  }

  /**
   * The system photo picker where it exists, the document picker otherwise.
   * Both are single-selection here and both restrict the type to images.
   */
  private fun pickerIntent(): Intent =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      Intent(MediaStore.ACTION_PICK_IMAGES).apply { type = MIME_ANY_IMAGE }
    } else {
      Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = MIME_ANY_IMAGE
        // Single selection only; no persistable grant is requested.
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
      }
    }

  override fun onActivityResult(
    activity: Activity,
    requestCode: Int,
    resultCode: Int,
    data: Intent?,
  ) {
    if (requestCode != REQUEST_CODE) {
      return
    }
    val promise = pending.getAndSet(null) ?: return

    if (resultCode != Activity.RESULT_OK) {
      // Cancelling is an ordinary outcome, reported as "no file".
      promise.resolve(emptyResult())
      return
    }
    // A successful result is *not* a cancellation, so a missing URI is a
    // malformed answer rather than a dismissal. Reporting it as "no file"
    // would tell the driver they had cancelled when in fact the picker
    // returned something unusable, and the screen would sit there offering
    // to choose again with no explanation.
    val uri = data?.data
    if (uri == null) {
      promise.reject(ERROR_UNREADABLE, MESSAGE_UNREADABLE)
      return
    }

    val file = describe(uri)
    if (file == null) {
      promise.reject(ERROR_UNREADABLE, MESSAGE_UNREADABLE)
      return
    }
    val result = Arguments.createMap()
    result.putMap(KEY_FILE, file)
    promise.resolve(result)
  }

  override fun onNewIntent(intent: Intent) {
    // Nothing to do: this module only answers its own activity result.
  }

  /**
   * What the resolver knows about the chosen item.
   *
   * Returns null when either value is missing **or when reading it throws**.
   * A `ContentResolver` talks to another process: `getType` and `query` can
   * both fail with a `SecurityException` when a grant has lapsed, or with a
   * provider's own `RuntimeException`, and either would otherwise escape
   * `onActivityResult` and surface in JavaScript as an unhandled native error
   * carrying the URI and the platform's message. Catching the whole read here
   * means the only thing that ever crosses the bridge is the fixed
   * `receipt_unreadable` code.
   *
   * Neither value is guessed: a MIME type inferred from an extension would be
   * a claim the provider never made, and the JavaScript side validates the
   * type against the three the API accepts anyway.
   */
  private fun describe(uri: Uri): WritableMap? {
    return try {
      val contentType = reactContext.contentResolver.getType(uri) ?: return null
      val byteSize = sizeOf(uri) ?: return null
      Arguments.createMap().apply {
        putString(KEY_URI, uri.toString())
        putString(KEY_CONTENT_TYPE, contentType)
        // A double on the wire; JavaScript checks it is a whole number.
        putDouble(KEY_BYTE_SIZE, byteSize.toDouble())
      }
    } catch (_: Throwable) {
      // Deliberately discarded: the message could name the URI, the provider
      // or the file path, none of which may reach JavaScript.
      null
    }
  }

  private fun sizeOf(uri: Uri): Long? {
    return try {
      reactContext.contentResolver
        .query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)
        ?.use { cursor ->
          val column = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (column < 0 || !cursor.moveToFirst() || cursor.isNull(column)) {
            null
          } else {
            cursor.getLong(column)
          }
        }
    } catch (_: Throwable) {
      null
    }
  }

  /** The cancellation shape: an object whose `file` is null. */
  private fun emptyResult(): WritableMap =
    Arguments.createMap().apply { putNull(KEY_FILE) }

  companion object {
    const val NAME = "ReceiptPicker"

    private const val REQUEST_CODE = 0x6F01
    private const val MIME_ANY_IMAGE = "image/*"

    private const val KEY_FILE = "file"
    private const val KEY_URI = "uri"
    private const val KEY_CONTENT_TYPE = "contentType"
    private const val KEY_BYTE_SIZE = "byteSize"

    // Fixed codes and messages. None of them carries a URI, a path, a
    // component name or a platform exception message.
    private const val ERROR_UNAVAILABLE = "receipt_picker_unavailable"
    private const val MESSAGE_UNAVAILABLE = "receipt picker unavailable"
    private const val ERROR_BUSY = "receipt_picker_busy"
    private const val MESSAGE_BUSY = "receipt picker already open"
    private const val ERROR_UNREADABLE = "receipt_unreadable"
    private const val MESSAGE_UNREADABLE = "receipt could not be read"
    private const val ERROR_CANCELLED = "receipt_picker_cancelled"
    private const val MESSAGE_CANCELLED = "receipt picker closed"
  }
}
