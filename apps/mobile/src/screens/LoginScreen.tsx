import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useSession } from '../auth/auth-context';
import { loginMessage } from '../auth/messages';
import { LoginError } from '../auth/session-manager';

/**
 * Minimal driver sign-in. The typed password lives in component state only
 * until submit; nothing about tokens ever reaches this component.
 */
export function LoginScreen() {
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await session.login(email, password);
      // Success unmounts this screen; the password state goes with it.
    } catch (failure) {
      setError(
        loginMessage(
          failure instanceof LoginError ? failure.reason : 'unavailable',
        ),
      );
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mansar Driver</Text>
      <Text style={styles.subtitle}>Sign in</Text>

      <Text style={styles.label}>Email</Text>
      <TextInput
        accessibilityLabel="Email"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        editable={!busy}
        keyboardType="email-address"
        onChangeText={setEmail}
        style={styles.input}
        textContentType="emailAddress"
        value={email}
      />

      <Text style={styles.label}>Password</Text>
      <TextInput
        accessibilityLabel="Password"
        autoCapitalize="none"
        autoComplete="password"
        autoCorrect={false}
        editable={!busy}
        onChangeText={setPassword}
        onSubmitEditing={() => {
          void submit();
        }}
        secureTextEntry
        style={styles.input}
        textContentType="password"
        value={password}
      />

      {error !== null ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy, disabled: busy }}
        disabled={busy}
        onPress={() => {
          void submit();
        }}
        style={[styles.button, busy && styles.buttonBusy]}
      >
        {busy ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={styles.buttonText}>Sign in</Text>
        )}
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
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 24,
  },
  label: {
    fontSize: 14,
    marginBottom: 4,
  },
  input: {
    borderColor: '#999999',
    borderRadius: 4,
    borderWidth: 1,
    fontSize: 16,
    marginBottom: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  error: {
    color: '#b00020',
    marginBottom: 16,
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#1f4e79',
    borderRadius: 4,
    justifyContent: 'center',
    minHeight: 48,
  },
  buttonBusy: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
