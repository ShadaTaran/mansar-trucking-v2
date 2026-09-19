import { MANSAR_PACKAGE_PROBE } from '@mansar/types';

/**
 * Development scaffold page.
 *
 * Proves the admin web app boots and consumes the `@mansar/types` workspace
 * package. Replaced by real application screens in later stages.
 */
export default function Home() {
  return (
    <main>
      <h1>Mansar Trucking Management System v2</h1>
      <p>Admin Web</p>
      <p>Development scaffold</p>
      <p>
        Workspace: <code>{MANSAR_PACKAGE_PROBE}</code>
      </p>
    </main>
  );
}
