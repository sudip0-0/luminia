// TokenStore backed by expo-secure-store (or an injected secure map for tests).

import type { TokenStore } from '../api/client';

const ACCESS_KEY = 'lumina.accessToken';
const REFRESH_KEY = 'lumina.refreshToken';

/** Minimal async secure storage surface (SecureStore-compatible). */
export interface SecureStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/**
 * Create a {@link TokenStore} that persists tokens in secure storage.
 * Reads are cached in memory after the first hydrate for synchronous API client use.
 */
export function createSecureTokenStore(storage: SecureStorage): TokenStore & {
  hydrate: () => Promise<void>;
} {
  let access: string | null = null;
  let refresh: string | null = null;

  return {
    async hydrate() {
      access = await storage.getItemAsync(ACCESS_KEY);
      refresh = await storage.getItemAsync(REFRESH_KEY);
    },
    getAccessToken: () => access,
    getRefreshToken: () => refresh,
    setTokens: (a, r) => {
      access = a;
      refresh = r;
      void storage.setItemAsync(ACCESS_KEY, a);
      void storage.setItemAsync(REFRESH_KEY, r);
    },
    clear: () => {
      access = null;
      refresh = null;
      void storage.deleteItemAsync(ACCESS_KEY);
      void storage.deleteItemAsync(REFRESH_KEY);
    },
  };
}

/** In-memory SecureStorage for unit tests. */
export function memorySecureStorage(
  initial: Record<string, string> = {},
): SecureStorage {
  const map = new Map(Object.entries(initial));
  return {
    async getItemAsync(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async setItemAsync(key, value) {
      map.set(key, value);
    },
    async deleteItemAsync(key) {
      map.delete(key);
    },
  };
}
