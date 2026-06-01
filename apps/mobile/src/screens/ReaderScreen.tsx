// Reader screen (Requirements 19.1-19.6).
//
// Renders cleaned full text with Lumina typography in dark mode, never shows
// ads, and presents "Go deeper" with min(n, 5) related articles only when at
// least 3 are available (Requirements 19.4, 19.5, gated by goDeeperDecision).
// When an article has no stored full text an external-browser control is shown
// (Requirement 19.6). Scroll depth is reported to the Signal_Collector via
// `onScrollDepth`.

import { ScrollView, StyleSheet, Text, Pressable, View } from 'react-native';
import type { Article } from '@lumina/shared';

import { goDeeperDecision } from '../reader/relatedGating.js';

export interface ReaderScreenProps {
  article: Article;
  related: Article[];
  onOpenRelated: (article: Article) => void;
  onOpenExternal: (article: Article) => void;
  /** Report max scrolled proportion [0,1] to the Signal_Collector (Req 19.3). */
  onScrollDepth?: (proportion: number) => void;
}

export function ReaderScreen({
  article,
  related,
  onOpenRelated,
  onOpenExternal,
  onScrollDepth,
}: ReaderScreenProps) {
  const decision = goDeeperDecision(related.length);
  const hasFullText = article.fullText != null && article.fullText.trim().length > 0;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      onScroll={(e) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        const denom = contentSize.height - layoutMeasurement.height;
        if (denom > 0) onScrollDepth?.(Math.min(1, Math.max(0, contentOffset.y / denom)));
      }}
      scrollEventThrottle={250}
    >
      <Text style={styles.title}>{article.title}</Text>
      {hasFullText ? (
        <Text style={styles.body}>{article.fullText}</Text>
      ) : (
        <Pressable style={styles.external} onPress={() => onOpenExternal(article)}>
          <Text style={styles.externalText}>Open in browser</Text>
        </Pressable>
      )}

      {decision.show ? (
        <View style={styles.goDeeper}>
          <Text style={styles.goDeeperTitle}>Go deeper</Text>
          {related.slice(0, decision.shownCount).map((r) => (
            <Pressable key={r.id} onPress={() => onOpenRelated(r)} style={styles.relatedRow}>
              <Text style={styles.relatedTitle}>{r.title}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0B0F' },
  content: { padding: 20 },
  title: { color: '#FFFFFF', fontSize: 26, fontWeight: '700', lineHeight: 32, marginBottom: 16 },
  body: { color: '#D6D6E0', fontSize: 17, lineHeight: 28 },
  external: { backgroundColor: '#6C4CE0', borderRadius: 12, padding: 14, alignItems: 'center' },
  externalText: { color: '#FFFFFF', fontWeight: '600' },
  goDeeper: { marginTop: 28, borderTopColor: '#23232E', borderTopWidth: 1, paddingTop: 16 },
  goDeeperTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '600', marginBottom: 8 },
  relatedRow: { paddingVertical: 10 },
  relatedTitle: { color: '#C9B8FF', fontSize: 15 },
});
