// Library screen (Requirement 21.4) — saved articles and collections.

import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Article } from '@lumina/shared';

import type { ApiClient } from '../api';
import { StatusBlock } from '../components/StatusBlock';

export interface LibraryScreenProps {
  api: ApiClient;
  onOpenArticle: (article: Article) => void;
}

type SavedPage = {
  items?: Article[];
  results?: { items?: Article[] };
};

export function LibraryScreen({ api, onOpenArticle }: LibraryScreenProps) {
  const [saved, setSaved] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getJson<SavedPage>('/library/saves');
      const items = res.items ?? res.results?.items ?? [];
      setSaved(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load library.');
      setSaved([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <StatusBlock kind="loading" label="Loading library" />;
  if (error) return <StatusBlock kind="error" message={error} onRetry={() => void load()} />;

  return (
    <View style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Library
      </Text>
      <FlatList
        data={saved}
        keyExtractor={(a) => a.id}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => onOpenArticle(item)}
            accessibilityRole="button"
            accessibilityLabel={item.title}
          >
            <Text style={styles.title}>{item.title}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<StatusBlock kind="empty" message="No saved articles yet." />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0B0F', padding: 16 },
  heading: { color: '#FFFFFF', fontSize: 22, fontWeight: '700', marginBottom: 12 },
  row: { paddingVertical: 12, borderBottomColor: '#1B1B24', borderBottomWidth: 1 },
  title: { color: '#E6E6EE', fontSize: 15 },
});
