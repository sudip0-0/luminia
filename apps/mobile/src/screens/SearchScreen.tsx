// Search screen (Requirements 20.4, 20.8).

import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Article } from '@lumina/shared';

import type { ApiClient } from '../api';
import { StatusBlock } from '../components/StatusBlock';
import { addSearchQuery } from '../search/searchHistory';

export interface SearchScreenProps {
  api: ApiClient;
  onOpenArticle: (article: Article) => void;
}

export function SearchScreen({ api, onOpenArticle }: SearchScreenProps) {
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [results, setResults] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = async (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length === 0) return;
    setHistory((h) => addSearchQuery(h, trimmed));
    setLoading(true);
    setError(null);
    try {
      const res = await api.getJson<{ results?: Article[]; items?: Article[] }>(
        `/search?q=${encodeURIComponent(trimmed)}`,
      );
      setResults(res.results ?? res.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="Search Lumina"
        placeholderTextColor="#7C7C8A"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => void runSearch(query)}
        returnKeyType="search"
        accessibilityLabel="Search Lumina"
        accessibilityRole="search"
      />
      {loading ? <StatusBlock kind="loading" label="Searching" /> : null}
      {error ? (
        <StatusBlock kind="error" message={error} onRetry={() => void runSearch(query)} />
      ) : null}
      {!loading && !error && history.length > 0 && results.length === 0 ? (
        <View style={styles.history}>
          {history.map((h) => (
            <Pressable
              key={h}
              onPress={() => {
                setQuery(h);
                void runSearch(h);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Search ${h}`}
            >
              <Text style={styles.historyItem}>{h}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <FlatList
        data={results}
        keyExtractor={(a) => a.id}
        renderItem={({ item }) => (
          <Pressable
            style={styles.result}
            onPress={() => onOpenArticle(item)}
            accessibilityRole="button"
            accessibilityLabel={item.title}
          >
            <Text style={styles.resultTitle}>{item.title}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0B0F', padding: 16 },
  input: { backgroundColor: '#15151C', borderRadius: 10, color: '#FFFFFF', padding: 12 },
  history: { marginTop: 12 },
  historyItem: { color: '#7C7C8A', paddingVertical: 8 },
  result: { paddingVertical: 12, borderBottomColor: '#1B1B24', borderBottomWidth: 1 },
  resultTitle: { color: '#E6E6EE', fontSize: 15 },
});
