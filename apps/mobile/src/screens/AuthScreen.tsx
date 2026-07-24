// Login / register screen wired to /auth/* endpoints.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ApiClient, TokenStore } from '../api';
import { StatusBlock } from '../components/StatusBlock';

export interface AuthScreenProps {
  api: ApiClient;
  tokens: TokenStore;
  onAuthenticated: () => void;
}

type Mode = 'login' | 'register';

export function AuthScreen({ api, tokens, onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register';
      const body = await api.postJson<{
        accessToken: string;
        refreshToken: string;
      }>(path, { email: email.trim(), password });
      tokens.setTokens(body.accessToken, body.refreshToken);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.brand} accessibilityRole="header">
        Lumina
      </Text>
      <Text style={styles.subtitle}>{mode === 'login' ? 'Sign in' : 'Create account'}</Text>
      <TextInput
        style={styles.input}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholder="Email"
        placeholderTextColor="#7C7C8A"
        value={email}
        onChangeText={setEmail}
        accessibilityLabel="Email"
      />
      <TextInput
        style={styles.input}
        secureTextEntry
        placeholder="Password"
        placeholderTextColor="#7C7C8A"
        value={password}
        onChangeText={setPassword}
        accessibilityLabel="Password"
      />
      {error ? <StatusBlock kind="error" message={error} /> : null}
      <Pressable
        style={styles.primary}
        onPress={() => void submit()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={mode === 'login' ? 'Sign in' : 'Create account'}
      >
        <Text style={styles.primaryText}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </Text>
      </Pressable>
      <Pressable
        onPress={() => setMode(mode === 'login' ? 'register' : 'login')}
        accessibilityRole="button"
        accessibilityLabel={
          mode === 'login' ? 'Switch to create account' : 'Switch to sign in'
        }
      >
        <Text style={styles.switch}>
          {mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B0B0F',
    padding: 24,
    justifyContent: 'center',
  },
  brand: { color: '#FFFFFF', fontSize: 36, fontWeight: '700', marginBottom: 8 },
  subtitle: { color: '#B8B8C4', fontSize: 16, marginBottom: 24 },
  input: {
    backgroundColor: '#15151C',
    borderRadius: 10,
    color: '#FFFFFF',
    padding: 12,
    marginBottom: 12,
  },
  primary: {
    backgroundColor: '#6C4CE0',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryText: { color: '#FFFFFF', fontWeight: '600' },
  switch: { color: '#C9B8FF', textAlign: 'center', marginTop: 16 },
});
