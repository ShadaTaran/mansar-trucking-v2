import type { AuthUser } from '@mansar/api-client';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useSession } from '../auth/auth-context';

/**
 * Authenticated placeholder until the trip screens arrive. Shows the public
 * identity only; there is no token information anywhere in this app's UI.
 */
export function DriverHomeScreen({ user }: { readonly user: AuthUser }) {
  const session = useSession();
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    // Local state is cleared first, which unmounts this screen; the API
    // revocation continues best-effort in the background.
    await session.logout();
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mansar Driver</Text>
      <Text style={styles.line}>Signed in as {user.email}</Text>
      <Text style={styles.line}>Role: {user.role}</Text>
      <Text style={styles.placeholder}>
        Trip screens arrive in a later stage.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy, disabled: busy }}
        disabled={busy}
        onPress={() => {
          void logout();
        }}
        style={[styles.button, busy && styles.buttonBusy]}
      >
        <Text style={styles.buttonText}>Sign out</Text>
      </Pressable>
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
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 16,
  },
  line: {
    fontSize: 16,
    marginBottom: 4,
  },
  placeholder: {
    fontSize: 14,
    marginBottom: 24,
    marginTop: 16,
    opacity: 0.7,
  },
  button: {
    alignItems: 'center',
    borderColor: '#1f4e79',
    borderRadius: 4,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
  },
  buttonBusy: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#1f4e79',
    fontSize: 16,
    fontWeight: '600',
  },
});
