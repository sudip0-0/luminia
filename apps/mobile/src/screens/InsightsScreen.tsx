// Insights screen (Requirements 24.1, 24.2, 24.4).

import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ApiClient } from '../api';
import { StatusBlock } from '../components/StatusBlock';

interface InsightsViewModel {
  articlesRead: number;
  qualityReadingMinutes: number;
  newlyDiscoveredTopics: number;
  narrative: string;
  emerging: { topicId: string }[];
}

export interface InsightsScreenProps {
  api: ApiClient;
}

export function InsightsScreen({ api }: InsightsScreenProps) {
  const [data, setData] = useState<InsightsViewModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [monthly, emerging, narrative] = await Promise.all([
        api.getJson<{
          articlesRead?: number;
          qualityReadingMinutes?: number;
          newlyDiscoveredTopics?: number;
        }>('/insights/monthly'),
        api.getJson<{ emerging?: { topicId: string }[]; topics?: { topicId: string }[] }>(
          '/insights/emerging',
        ),
        api.getJson<{ narrative?: string; text?: string }>('/insights/narrative'),
      ]);
      setData({
        articlesRead: monthly.articlesRead ?? 0,
        qualityReadingMinutes: monthly.qualityReadingMinutes ?? 0,
        newlyDiscoveredTopics: monthly.newlyDiscoveredTopics ?? 0,
        narrative: narrative.narrative ?? narrative.text ?? '',
        emerging: emerging.emerging ?? emerging.topics ?? [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load insights.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <StatusBlock kind="loading" label="Loading insights" />;
  if (error) return <StatusBlock kind="error" message={error} onRetry={() => void load()} />;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading} accessibilityRole="header">
        Your month
      </Text>
      {data ? (
        <>
          <Text style={styles.stat}>{data.articlesRead} articles read</Text>
          <Text style={styles.stat}>{data.qualityReadingMinutes} minutes of quality reading</Text>
          <Text style={styles.stat}>{data.newlyDiscoveredTopics} new topics discovered</Text>
          {data.narrative ? <Text style={styles.narrative}>{data.narrative}</Text> : null}
          {data.emerging.length > 0 ? (
            <View style={styles.emerging}>
              <Text style={styles.subheading}>Emerging interests</Text>
              {data.emerging.map((e) => (
                <Text key={e.topicId} style={styles.stat}>
                  {e.topicId}
                </Text>
              ))}
            </View>
          ) : null}
        </>
      ) : (
        <StatusBlock kind="empty" message="No insights yet." />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0B0F' },
  content: { padding: 20 },
  heading: { color: '#FFFFFF', fontSize: 22, fontWeight: '700', marginBottom: 16 },
  subheading: { color: '#FFFFFF', fontSize: 18, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  stat: { color: '#D6D6E0', fontSize: 16, marginVertical: 4 },
  narrative: { color: '#C9B8FF', fontSize: 15, marginTop: 16, lineHeight: 22 },
  emerging: { marginTop: 8 },
});
