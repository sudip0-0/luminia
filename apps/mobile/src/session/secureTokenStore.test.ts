import { describe, expect, it } from 'vitest';
import {
  createSecureTokenStore,
  memorySecureStorage,
} from './secureTokenStore.js';

describe('createSecureTokenStore', () => {
  it('hydrates and persists tokens', async () => {
    const storage = memorySecureStorage();
    const store = createSecureTokenStore(storage);

    store.setTokens('a1', 'r1');
    expect(store.getAccessToken()).toBe('a1');
    expect(await storage.getItemAsync('lumina.accessToken')).toBe('a1');

    const again = createSecureTokenStore(storage);
    await again.hydrate();
    expect(again.getAccessToken()).toBe('a1');
    expect(again.getRefreshToken()).toBe('r1');

    again.clear();
    expect(again.getAccessToken()).toBeNull();
    expect(await storage.getItemAsync('lumina.accessToken')).toBeNull();
  });
});
