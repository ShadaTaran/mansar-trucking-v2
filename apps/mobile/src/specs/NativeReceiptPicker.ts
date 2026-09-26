import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Local receipt image selection (codegen spec).
 *
 * The module opens the platform's own picker and returns what the
 * `ContentResolver` says about the chosen item. It reads nothing else: no
 * gallery listing, no directory traversal, no camera, and no persisted URI
 * permission — the grant lasts for this foreground flow, which is all the
 * upload needs.
 *
 * `null` means the driver cancelled, which is an ordinary outcome rather than
 * an error. Codegen cannot express a nullable object return directly, so the
 * result is a nullable *struct field*: the method always resolves an object,
 * and `file` inside it is null on cancellation. `receipt-picker.ts` is the
 * only consumer and collapses that back into the frozen
 * `PickedReceiptFile | null` semantic, so no component sees this shape.
 *
 * `uri` is local-only and never sent to the Mansar API; `contentType` and
 * `byteSize` are the only two values the upload authorization request
 * carries. No filename is returned, because none is needed: React Native's
 * FormData treats the file part's name as optional, and a client-chosen
 * filename is not receipt metadata.
 */

export interface PickedFile {
  uri: string;
  contentType: string;
  byteSize: number;
}

export interface PickResult {
  /** The chosen image, or null when the driver cancelled. */
  file: PickedFile | null;
}

export interface Spec extends TurboModule {
  /**
   * Opens the picker and resolves once the driver has chosen or cancelled.
   *
   * Rejects with a fixed code — never a URI, file path or provider detail —
   * when the picker cannot be opened, when a selection cannot be read, or
   * when a request is already outstanding.
   */
  pickReceiptImage(): Promise<PickResult>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('ReceiptPicker');
