import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { Article } from '@lumina/shared';

import { createApiClient, type TokenStore } from './api/index.js';
import { DEFAULT_API_BASE_URL } from './config.js';
import { OnboardingScreen } from './screens/OnboardingScreen.js';
import { FeedScreen } from './screens/FeedScreen.js';
import { ReaderScreen } from './screens/ReaderScreen.js';
import { SearchScreen } from './screens/SearchScreen.js';
import { LibraryScreen } from './screens/LibraryScreen.js';
import { InsightsScreen } from './screens/InsightsScreen.js';

/** The top-level navigation destinations. */
type Tab = 'feed' | 'search' | 'library' | 'insights';

/**
 * Root of the Lumina Mobile_App. A lightweight state-driven navigator wires the
 * onboarding flow, the tabbed main surface (feed, search, library, insights),
 * and the Reader, all backed by the {@link createApiClient} API client with
 * transparent token refresh (Requirement 2.3).
 *
 * The token store is a simple in-memory placeholder here; a durable
 * SecureStore-backed store is substituted on-device.
 */
export default function App() {
  const tokens = useMemo<TokenStore>(() => inMemoryTokenStore(), []);
  const api = useMemo(
    () => createApiClient({ baseUrl: DEFAULT_API_BASE_URL, tokens }),
    [tokens],
  );

  const [onboarded, setOnboarded] = useState(false);
  const [dailyGoal, setDailyGoal] = useState(15);
  const [tab, setTab] = useState<Tab>('feed');
  const [reading, setReading] = useState<Article | null>(null);

  if (!onboarded) {
    return (
      <OnboardingScreen
        api={api}
        onComplete={(goal) => {
          setDailyGoal(goal);
          setOnboarded(true);
        }}
      />
    );
  }

  if (reading) {
    return (
      <ReaderScreen
        article={reading}
        related={[]}
        onOpenRelated={setReading}
        onOpenExternal={() => undefined}
      />
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.screen}>
        {tab === 'feed' && (
          <FeedScreen
            api={api}
            dailyGoalMinutes={dailyGoal}
            onOpenArticle={setReading}
            onAction={() => undefined}
          />
        )}
        {tab === 'search' && <SearchScreen api={api} onOpenArticle={setReading} />}
        {tab === 'library' && <LibraryScreen api={api} onOpenArticle={setReading} />}
        {tab === 'insights' && <InsightsScreen api={api} />}
      </View>
      <View style={styles.tabBar}>
        {(['feed', 'search', 'library', 'insights'] as Tab[]).map((t) => (
          <Pressable key={t} style={styles.tabButton} onPress={() => setTab(t)}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t}</Text>
          </Pressable>
        ))}
      </View>
      <StatusBar style="light" />
    </View>
  );
}

/** A non-durable in-memory token store placeholder for the app shell. */
function inMemoryTokenStore(): TokenStore {
  let access: string | null = null;
  let refresh: string | null = null;
  return {
    getAccessToken: () => access,
    getRefreshToken: () => refresh,
    setTokens: (a, r) => {
      access = a;
      refresh = r;
    },
    clear: () => {
      access = null;
      refresh = null;
    },
  };
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0B0F' },
  screen: { flex: 1 },
  tabBar: { flexDirection: 'row', borderTopColor: '#1B1B24', borderTopWidth: 1, backgroundColor: '#0B0B0F' },
  tabButton: { flex: 1, paddingVertical: 14, alignItems: 'center' },
  tabText: { color: '#7C7C8A', fontSize: 13 },
  tabTextActive: { color: '#C9B8FF', fontWeight: '600' },
});
