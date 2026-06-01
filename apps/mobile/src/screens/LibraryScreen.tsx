// Library screen (Requirement 21.4) — saved articles and collections.

import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Article } from '@lumina/shared';

import type { ApiClient } from '../api/index.js';

export interface LibraryScreenProps {
  api: ApiClient;
  onOpenArticle: (article: Article) => void;
}

export function LibraryScreen({ api, onOpenArticle }: LibraryScreenProps) {
  const [saved, setSaved] = useState<Article[]>([]);

  useEffect(() => {
    api
      .getJson<{ items: Article[] }>('/library/saved')
      .then((res) => setSaved(res.items))
      .catch(() => setSaved([]));
  }, [api]);

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Library</Text>
      <FlatList
        data={saved}
        keyExtractor={(a) => a.id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => onOpenArticle(item)}>
            <Text style={styles.title}>{item.title}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No saved articles yet.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0B0F', padding: 16 },
  heading: { color: '#FFFFFF', fontSize: 22, fontWeight: '700', marginBottom: 12 },
  row: { paddingVertical: 12, borderBottomColor: '#1B1B24', borderBottomWidth: 1 },
  title: { color: '#E6E6EE', fontSize: 15 },
  empty: { color: '#7C7C8A' },
});
