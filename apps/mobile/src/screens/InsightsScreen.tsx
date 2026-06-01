// Insights screen (Requirements 24.1, 24.2, 24.4) — monthly stats, topic
// breakdown, emerging interests, and the feed-evolution narrative.

import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ApiClient } from '../api/index.js';

interface InsightsDto {
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
  const [data, setData] = useState<InsightsDto | null>(null);

  useEffect(() => {
    api
      .getJson<InsightsDto>('/insights')
      .then(setData)
      .catch(() => setData(null));
  }, [api]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Your month</Text>
      {data ? (
        <>
          <Text style={styles.stat}>{data.articlesRead} articles read</Text>
          <Text style={styles.stat}>{data.qualityReadingMinutes} minutes of quality reading</Text>
          <Text style={styles.stat}>{data.newlyDiscoveredTopics} new topics discovered</Text>
          <Text style={styles.narrative}>{data.narrative}</Text>
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
        <Text style={styles.stat}>No insights yet.</Text>
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
