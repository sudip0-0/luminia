import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

export type StatusBlockProps =
  | { kind: 'loading'; label?: string }
  | { kind: 'error'; message: string; onRetry?: () => void }
  | { kind: 'empty'; message: string };

/** Shared loading / error / empty status for list screens. */
export function StatusBlock(props: StatusBlockProps) {
  if (props.kind === 'loading') {
    return (
      <View style={styles.wrap} accessibilityRole="progressbar" accessibilityLabel={props.label ?? 'Loading'}>
        <ActivityIndicator color="#C9B8FF" />
        <Text style={styles.text}>{props.label ?? 'Loading…'}</Text>
      </View>
    );
  }
  if (props.kind === 'error') {
    return (
      <View style={styles.wrap} accessibilityRole="alert">
        <Text style={styles.error}>{props.message}</Text>
        {props.onRetry ? (
          <Pressable
            style={styles.retry}
            onPress={props.onRetry}
            accessibilityRole="button"
            accessibilityLabel="Retry"
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.wrap}>
      <Text style={styles.text}>{props.message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 24, alignItems: 'center', gap: 12 },
  text: { color: '#7C7C8A', fontSize: 14 },
  error: { color: '#FF8A8A', fontSize: 14, textAlign: 'center' },
  retry: {
    backgroundColor: '#6C4CE0',
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  retryText: { color: '#FFFFFF', fontWeight: '600' },
});
