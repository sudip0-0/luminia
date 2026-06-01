// Feed card (Requirements 17.1-17.4, 10.4).
//
// Renders read-time and source, NEVER engagement counts, and never autoplays
// media. Serendipity cards show a "Something new" pill (Requirement 10.4).
// Gestures (Requirement 23): short tap opens the Reader, a 500ms long-press
// opens the action sheet; swipe-left skip is surfaced via `onSkip` (wired by
// the feed screen's gesture layer).

import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Article } from '@lumina/shared';

export interface FeedCardProps {
  article: Article;
  /** Whether this card is an injected Serendipity_Card (shows the pill). */
  serendipity?: boolean;
  /** Short tap — open in the Reader (Requirement 23.3). */
  onOpen: (article: Article) => void;
  /** 500ms long-press — present the action sheet (Requirement 23.2). */
  onLongPress: (article: Article) => void;
}

/** Long-press threshold in ms (Requirement 23.2). */
export const LONG_PRESS_MS = 500;

export function FeedCard({ article, serendipity, onOpen, onLongPress }: FeedCardProps) {
  return (
    <Pressable
      style={styles.card}
      onPress={() => onOpen(article)}
      onLongPress={() => onLongPress(article)}
      delayLongPress={LONG_PRESS_MS}
      accessibilityRole="button"
    >
      {serendipity ? (
        <View style={styles.pill}>
          <Text style={styles.pillText}>Something new</Text>
        </View>
      ) : null}
      <Text style={styles.title}>{article.title}</Text>
      <Text style={styles.summary} numberOfLines={3}>
        {article.summary}
      </Text>
      <View style={styles.meta}>
        <Text style={styles.metaText}>{article.source}</Text>
        <Text style={styles.metaText}>{article.readTimeMinutes} min read</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#15151C', borderRadius: 12, padding: 16, marginVertical: 6 },
  pill: { alignSelf: 'flex-start', backgroundColor: '#3A2F5B', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, marginBottom: 8 },
  pillText: { color: '#C9B8FF', fontSize: 12, fontWeight: '600' },
  title: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
  summary: { color: '#B8B8C4', fontSize: 14, marginTop: 6 },
  meta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  metaText: { color: '#7C7C8A', fontSize: 12 },
});
