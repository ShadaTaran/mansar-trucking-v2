import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Build-time configuration exposed by the Android app (codegen spec).
 *
 * The only value is the API base URL fixed by the Gradle build type
 * (`BuildConfig.MANSAR_API_BASE_URL`): configuration, never a credential.
 * Nothing here is user-editable at runtime.
 */
export interface Spec extends TurboModule {
  getConstants(): {
    apiBaseUrl: string;
  };
}

export default TurboModuleRegistry.getEnforcing<Spec>('MansarConfig');
