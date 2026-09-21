import { StyleSheet, Text, View } from 'react-native';

/**
 * Fail-closed screen for a build without a usable API endpoint (for example
 * a release build before a production endpoint is approved). No session,
 * API client or network request exists behind this screen.
 */
export function UnconfiguredBuildScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mansar Driver</Text>
      <Text accessibilityRole="alert" style={styles.message}>
        This build has no API endpoint configured.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 16,
  },
  message: {
    fontSize: 16,
    textAlign: 'center',
  },
});
