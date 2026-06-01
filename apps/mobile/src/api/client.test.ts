import { describe, it, expect, vi } from 'vitest';

import { createApiClient, type TokenStore } from './client.js';

// Tests for transparent access-token refresh on 401 (Requirement 2.3).

function memoryTokenStore(access: string | null, refresh: string | null): TokenStore {
  let a = access;
  let r = refresh;
  return {
    getAccessToken: () => a,
    getRefreshToken: () => r,
    setTokens: (na, nr) => {
      a = na;
      r = nr;
    },
    clear: () => {
      a = null;
      r = null;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createApiClient — transparent token refresh (Req 2.3)', () => {
  it('attaches the bearer access token to requests', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createApiClient({
      baseUrl: 'http://api',
      tokens: memoryTokenStore('access-1', 'refresh-1'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.getJson('/feed');

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer access-1');
  });

  it('refreshes and retries once on a 401, then succeeds', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === 'http://api/feed' && calls.filter((u) => u === 'http://api/feed').length === 1) {
        return jsonResponse({ error: 'expired' }, 401);
      }
      if (url === 'http://api/auth/refresh') {
        return jsonResponse({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      }
      return jsonResponse({ articles: [] });
    });
    const tokens = memoryTokenStore('access-1', 'refresh-1');
    const client = createApiClient({
      baseUrl: 'http://api',
      tokens,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const res = await client.request('/feed');

    expect(res.status).toBe(200);
    expect(calls).toEqual(['http://api/feed', 'http://api/auth/refresh', 'http://api/feed']);
    expect(tokens.getAccessToken()).toBe('access-2');
  });

  it('clears tokens and surfaces the 401 when refresh fails', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'http://api/auth/refresh') return jsonResponse({ error: 'bad' }, 401);
      return jsonResponse({ error: 'expired' }, 401);
    });
    const tokens = memoryTokenStore('access-1', 'refresh-1');
    const client = createApiClient({
      baseUrl: 'http://api',
      tokens,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const res = await client.request('/feed');

    expect(res.status).toBe(401);
    expect(tokens.getAccessToken()).toBeNull();
    expect(tokens.getRefreshToken()).toBeNull();
  });

  it('does not attempt refresh when there is no refresh token', async () => {
    const refreshCalls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) refreshCalls.push(url);
      return jsonResponse({ error: 'expired' }, 401);
    });
    const client = createApiClient({
      baseUrl: 'http://api',
      tokens: memoryTokenStore('access-1', null),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const res = await client.request('/feed');

    expect(res.status).toBe(401);
    expect(refreshCalls).toHaveLength(0);
  });
});
