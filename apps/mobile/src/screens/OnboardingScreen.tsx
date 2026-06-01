// Onboarding flow screen (Requirements 4.1-4.7).
//
// Routes un-onboarded users here, gates the advance control until >=3 topics
// and exactly one depth are selected (Requirements 4.2, 4.3), enables all six
// sources by default (Requirement 4.4), and submits the selection, loading the
// first feed on success (Requirement 4.6) while preserving onboarding state if
// feed assembly fails (Requirement 4.7).

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Depth } from '@lumina/shared';

import type { ApiClient, OnboardingCompleteRequest, TaxonomyTopicDto } from '../api/index.js';
import { canAdvanceOnboarding, DEFAULT_ENABLED_SOURCES } from '../onboarding/gating.js';

const DEPTHS: Depth[] = ['quick', 'balanced', 'deep'];
const DEFAULT_DAILY_GOAL = 15;

export interface OnboardingScreenProps {
  api: ApiClient;
  /** Invoked with the chosen Daily_Goal once onboarding succeeds. */
  onComplete: (dailyGoalMinutes: number) => void;
}

export function OnboardingScreen({ api, onComplete }: OnboardingScreenProps) {
  const [topics, setTopics] = useState<TaxonomyTopicDto[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [depth, setDepth] = useState<Depth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getJson<{ topics: TaxonomyTopicDto[] }>('/onboarding/topics')
      .then((res) => setTopics(res.topics))
      .catch(() => setError('Could not load topics.'));
  }, [api]);

  const toggleTopic = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));

  const canAdvance = canAdvanceOnboarding({ topicIds: selected, depth });

  const submit = async () => {
    if (!canAdvance || depth === null) return;
    const body: OnboardingCompleteRequest = {
      topicIds: selected,
      depth,
      dailyGoalMinutes: DEFAULT_DAILY_GOAL,
      enabledSources: [...DEFAULT_ENABLED_SOURCES],
    };
    try {
      await api.postJson('/onboarding/complete', body);
      onComplete(DEFAULT_DAILY_GOAL); // (4.6) proceed to the first feed
    } catch {
      setError('Could not start your feed. Your selections are preserved.'); // (4.7)
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Pick at least 3 topics</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.chips}>
        {topics.map((t) => (
          <Pressable
            key={t.id}
            style={[styles.chip, selected.includes(t.id) && styles.chipOn]}
            onPress={() => toggleTopic(t.id)}
          >
            <Text style={styles.chipText}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.heading}>Choose a reading depth</Text>
      <View style={styles.chips}>
        {DEPTHS.map((d) => (
          <Pressable key={d} style={[styles.chip, depth === d && styles.chipOn]} onPress={() => setDepth(d)}>
            <Text style={styles.chipText}>{d}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        style={[styles.advance, !canAdvance && styles.advanceDisabled]}
        disabled={!canAdvance}
        onPress={submit}
      >
        <Text style={styles.advanceText}>Start reading</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0B0F' },
  content: { padding: 20 },
  heading: { color: '#FFFFFF', fontSize: 20, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  error: { color: '#FF8A8A', marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#1B1B24', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  chipOn: { backgroundColor: '#3A2F5B' },
  chipText: { color: '#E6E6EE', fontSize: 14 },
  advance: { backgroundColor: '#6C4CE0', borderRadius: 12, padding: 16, marginTop: 28, alignItems: 'center' },
  advanceDisabled: { backgroundColor: '#2A2A36' },
  advanceText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
