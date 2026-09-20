import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useSession } from '../auth/auth-context';

/** Shown while the stored session is being verified; never the login form. */
export function BootstrapScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mansar Driver</Text>
      <ActivityIndicator accessibilityLabel="Checking your session" />
    </View>
  );
}

/**
 * The stored session could not be verified because the API was unreachable
 * or failing. The stored refresh token is kept; the driver can retry.
 */
export function BootstrapErrorScreen() {
  const session = useSession();
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mansar Driver</Text>
      <Text style={styles.message}>
        Unable to reach the server. Check your connection and try again.
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void session.bootstrap();
        }}
        style={styles.button}
      >
        <Text style={styles.buttonText}>Try again</Text>
      </Pressable>
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
    marginBottom: 24,
  },
  message: {
    fontSize: 16,
    marginBottom: 24,
    textAlign: 'center',
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#1f4e79',
    borderRadius: 4,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 24,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
