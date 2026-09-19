import { MANSAR_PACKAGE_PROBE } from '@mansar/types';
import { StyleSheet, Text, View } from 'react-native';

/**
 * Development scaffold screen.
 *
 * Proves the driver app boots on Android and consumes the `@mansar/types`
 * workspace package through Metro. Replaced by real screens in later stages.
 */
function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mansar Trucking Management System v2</Text>
      <Text style={styles.line}>Driver Mobile</Text>
      <Text style={styles.line}>Development scaffold</Text>
      <Text style={styles.line}>
        Workspace: <Text style={styles.probe}>{MANSAR_PACKAGE_PROBE}</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 12,
  },
  line: {
    fontSize: 16,
    marginBottom: 4,
  },
  probe: {
    fontFamily: 'monospace',
  },
});

export default App;
