import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import type { Article } from '@lumina/shared';

import { createApiClient, type TokenStore } from './api';
import { DEFAULT_API_BASE_URL } from './config';
import { createSecureTokenStore } from './session/secureTokenStore';
import { AuthScreen } from './screens/AuthScreen';
import { OnboardingScreen } from './screens/OnboardingScreen';
import { FeedScreen } from './screens/FeedScreen';
import { ReaderScreen } from './screens/ReaderScreen';
import { SearchScreen } from './screens/SearchScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { InsightsScreen } from './screens/InsightsScreen';

type Tab = 'feed' | 'search' | 'library' | 'insights';

type RootStackParamList = {
  Auth: undefined;
  Onboarding: undefined;
  Main: undefined;
  Reader: { article: Article };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

const secureStorage = {
  getItemAsync: (key: string) => SecureStore.getItemAsync(key),
  setItemAsync: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  deleteItemAsync: (key: string) => SecureStore.deleteItemAsync(key),
};

function MainTabs({
  api,
  dailyGoal,
  onOpenArticle,
}: {
  api: ReturnType<typeof createApiClient>;
  dailyGoal: number;
  onOpenArticle: (article: Article) => void;
}) {
  const [tab, setTab] = useState<Tab>('feed');

  return (
    <View style={styles.container}>
      <View style={styles.screen}>
        {tab === 'feed' && (
          <FeedScreen
            api={api}
            dailyGoalMinutes={dailyGoal}
            onOpenArticle={onOpenArticle}
            onAction={() => undefined}
          />
        )}
        {tab === 'search' && <SearchScreen api={api} onOpenArticle={onOpenArticle} />}
        {tab === 'library' && <LibraryScreen api={api} onOpenArticle={onOpenArticle} />}
        {tab === 'insights' && <InsightsScreen api={api} />}
      </View>
      <View style={styles.tabBar} accessibilityRole="tablist">
        {(['feed', 'search', 'library', 'insights'] as Tab[]).map((t) => (
          <Pressable
            key={t}
            style={styles.tabButton}
            onPress={() => setTab(t)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t }}
            accessibilityLabel={`${t} tab`}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/**
 * Root of the Lumina Mobile_App: Auth → Onboarding → Main tabs → Reader,
 * with SecureStore-backed tokens and transparent refresh.
 */
export default function App() {
  const tokenStore = useMemo(() => createSecureTokenStore(secureStorage), []);
  const api = useMemo(
    () => createApiClient({ baseUrl: DEFAULT_API_BASE_URL, tokens: tokenStore }),
    [tokenStore],
  );

  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [onboarded, setOnboarded] = useState(false);
  const [dailyGoal, setDailyGoal] = useState(15);

  useEffect(() => {
    void (async () => {
      await tokenStore.hydrate();
      setAuthed(Boolean(tokenStore.getAccessToken() || tokenStore.getRefreshToken()));
      setReady(true);
    })();
  }, [tokenStore]);

  if (!ready) {
    return <View style={styles.container} />;
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0B0B0F' } }}>
          {!authed ? (
            <Stack.Screen name="Auth">
              {() => (
                <AuthScreen
                  api={api}
                  tokens={tokenStore as TokenStore}
                  onAuthenticated={() => setAuthed(true)}
                />
              )}
            </Stack.Screen>
          ) : !onboarded ? (
            <Stack.Screen name="Onboarding">
              {() => (
                <OnboardingScreen
                  api={api}
                  onComplete={(goal) => {
                    setDailyGoal(goal);
                    setOnboarded(true);
                  }}
                />
              )}
            </Stack.Screen>
          ) : (
            <>
              <Stack.Screen name="Main">
                {({ navigation }) => (
                  <MainTabs
                    api={api}
                    dailyGoal={dailyGoal}
                    onOpenArticle={(article) => navigation.navigate('Reader', { article })}
                  />
                )}
              </Stack.Screen>
              <Stack.Screen name="Reader">
                {({ route, navigation }) => (
                  <ReaderScreen
                    article={route.params.article}
                    related={[]}
                    onOpenRelated={(article) => navigation.push('Reader', { article })}
                    onOpenExternal={() => undefined}
                  />
                )}
              </Stack.Screen>
            </>
          )}
        </Stack.Navigator>
        <StatusBar style="light" />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0B0F' },
  screen: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    borderTopColor: '#1B1B24',
    borderTopWidth: 1,
    backgroundColor: '#0B0B0F',
  },
  tabButton: { flex: 1, paddingVertical: 14, alignItems: 'center' },
  tabText: { color: '#7C7C8A', fontSize: 13 },
  tabTextActive: { color: '#C9B8FF', fontWeight: '700' },
});
