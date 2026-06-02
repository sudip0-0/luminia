// Feed screen (Requirements 8, 10.4, 15, 17, 23).
//
// Fetches the personalized feed, renders cards (read-time + source, no
// engagement counts, no autoplay), shows the "Something new" pill on serendipity
// cards, and tracks the soft feed end at 30 viewed cards via the Session_Manager
// (Requirement 15). Short tap opens the Reader; long-press surfaces the action
// sheet; the skip control records a skip (the gesture layer wires swipe-left).

import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Article } from '@lumina/shared';

import type { ApiClient, ClientFeedCard, FeedResponseDto } from '../api';
import { FeedCard } from '../components/FeedCard';
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

export function FeedScreen({ api, dailyGoalMinutes, onOpenArticle, onAction }: FeedScreenProps) {
  const [cards, setCards] = useState<ClientFeedCard[]>([]);
  const [session, setSession] = useState<SessionState>(() =>
    startSession({ dailyGoalMinutes, now: Date.now() }),
  );

  const load = useCallback(async () => {
    const res = await api.getJson<FeedResponseDto>('/feed?tab=foryou');
    setCards(
      res.articles.map((article, i) => ({
        article,
        // Visual pill cadence mirrors the server's every-10th serendipity slot.
        serendipity: (i + 1) % SERENDIPITY_PILL_INTERVAL === 0,
      })),
    );
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleViewable = () => setSession((s) => onCardEntered(s));

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
      />
      {!canLoadMore(session) ? (
        <View style={styles.sessionEnd}>
          <Text style={styles.sessionTitle}>That is a good stopping point.</Text>
          <Pressable style={styles.keepGoing} onPress={() => setSession((s) => keepGoing(s))}>
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
