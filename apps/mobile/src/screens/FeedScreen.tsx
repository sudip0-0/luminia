// Feed screen (Requirements 8, 10.4, 15, 17, 23).

import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Article } from '@lumina/shared';

import type { ApiClient, ClientFeedCard, FeedResponseDto } from '../api';
import { FeedCard } from '../components/FeedCard';
import { StatusBlock } from '../components/StatusBlock';
import {
  canLoadMore,
  onCardEntered,
  keepGoing,
  startSession,
  type SessionState,
} from '../session/sessionManager';
import { SERENDIPITY_PILL_INTERVAL } from './feedCards';

export interface FeedScreenProps {
  api: ApiClient;
  dailyGoalMinutes: number;
  onOpenArticle: (article: Article) => void;
  onAction: (article: Article) => void;
}

type LoadState = 'loading' | 'ready' | 'error';

export function FeedScreen({ api, dailyGoalMinutes, onOpenArticle, onAction }: FeedScreenProps) {
  const [cards, setCards] = useState<ClientFeedCard[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState('Something went wrong.');
  const [session, setSession] = useState<SessionState>(() =>
    startSession({ dailyGoalMinutes, now: Date.now() }),
  );

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await api.getJson<FeedResponseDto>('/feed?tab=foryou');
      setCards(
        res.articles.map((article, i) => ({
          article,
          serendipity: (i + 1) % SERENDIPITY_PILL_INTERVAL === 0,
        })),
      );
      setLoadState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load feed.');
      setLoadState('error');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleViewable = () => setSession((s) => onCardEntered(s));

  if (loadState === 'loading' && cards.length === 0) {
    return <StatusBlock kind="loading" label="Loading feed" />;
  }
  if (loadState === 'error' && cards.length === 0) {
    return <StatusBlock kind="error" message={errorMessage} onRetry={() => void load()} />;
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={cards}
        keyExtractor={(c) => c.article.id}
        renderItem={({ item }) => (
          <FeedCard
            article={item.article}
            serendipity={item.serendipity}
            onOpen={onOpenArticle}
            onLongPress={onAction}
          />
        )}
        onViewableItemsChanged={handleViewable}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<StatusBlock kind="empty" message="No articles yet." />}
      />
      {!canLoadMore(session) ? (
        <View style={styles.sessionEnd} accessibilityRole="summary">
          <Text style={styles.sessionTitle}>That is a good stopping point.</Text>
          <Pressable
            style={styles.keepGoing}
            onPress={() => setSession((s) => keepGoing(s))}
            accessibilityRole="button"
            accessibilityLabel="Keep going"
          >
            <Text style={styles.keepGoingText}>Keep going</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0B0F' },
  list: { padding: 16 },
  sessionEnd: { padding: 24, backgroundColor: '#15151C', alignItems: 'center' },
  sessionTitle: { color: '#FFFFFF', fontSize: 16, marginBottom: 12 },
  keepGoing: { backgroundColor: '#6C4CE0', borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12 },
  keepGoingText: { color: '#FFFFFF', fontWeight: '600' },
});
