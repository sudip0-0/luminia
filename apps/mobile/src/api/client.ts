// Mobile_App API client with transparent access-token refresh (task 28.2,
// Requirement 2.3).
//
// `createApiClient` returns a thin typed wrapper over `fetch` that attaches the
// bearer access token to every request and, on a 401 response, transparently
// refreshes the access token using the stored refresh token and retries the
// original request exactly once. If the refresh itself fails the stored tokens
// are cleared and the original 401 surfaces to the caller, so the UI can route
// back to sign-in.
//
// Both `fetch` and the token store are injected, so the refresh/retry logic is
// fully unit-testable with a fake transport and an in-memory token store — no
// device or network required.

/** Persisted auth tokens. A concrete store (SecureStore/SQLite) implements this. */
export interface TokenStore {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  setTokens(accessToken: string, refreshToken: string): void;
  clear(): void;
}

/** Dependencies for {@link createApiClient}. */
export interface ApiClientDeps {
  /** API base URL, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** The token store used to read/refresh/clear credentials. */
  tokens: TokenStore;
  /** Injected fetch implementation; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The refresh endpoint's success payload. */
interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

/** The API client surface used by the screens. */
export interface ApiClient {
  /** Issue a request to `path`, refreshing + retrying once on a 401. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Convenience: request `path` and parse a JSON body of type `T`. */
  getJson<T>(path: string): Promise<T>;
  /** Convenience: POST `body` as JSON to `path` and parse a JSON body of type `T`. */
  postJson<T>(path: string, body: unknown): Promise<T>;
}

/**
 * Create an {@link ApiClient}. Every request carries the current access token;
 * a 401 triggers a single refresh-and-retry (Requirement 2.3). A failed refresh
 * clears the stored tokens and rethrows the original 401 response.
 */
export function createApiClient(deps: ApiClientDeps): ApiClient {
  const { baseUrl, tokens } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  function withAuth(init: RequestInit | undefined): RequestInit {
    const access = tokens.getAccessToken();
    const headers = new Headers(init?.headers);
    if (access) headers.set('Authorization', `Bearer ${access}`);
    return { ...init, headers };
  }

  async function tryRefresh(): Promise<boolean> {
    const refreshToken = tokens.getRefreshToken();
    if (!refreshToken) return false;
    const res = await fetchImpl(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      tokens.clear();
      return false;
    }
    const body = (await res.json()) as RefreshResponse;
    tokens.setTokens(body.accessToken, body.refreshToken);
    return true;
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const url = `${baseUrl}${path}`;
    const first = await fetchImpl(url, withAuth(init));
    if (first.status !== 401) return first;

    // (2.3) Transparent refresh + single retry on an expired/invalid access token.
    const refreshed = await tryRefresh();
    if (!refreshed) return first;
    return fetchImpl(url, withAuth(init));
  }

  async function getJson<T>(path: string): Promise<T> {
    const res = await request(path);
    return (await res.json()) as T;
  }

  async function postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  }

  return { request, getJson, postJson };
}
