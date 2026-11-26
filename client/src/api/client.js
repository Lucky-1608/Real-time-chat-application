export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(
  /\/+$/,
  ''
);

// Access token and CSRF token live strictly in memory (never localStorage).
let inMemoryToken = null;
let inMemoryCsrfToken = null;
let onUnauthorizedHandler = null;
let onTokenRefreshedHandler = null;
let inFlightRefreshPromise = null;

export async function ensureCsrfToken() {
  if (inMemoryCsrfToken) return inMemoryCsrfToken;
  try {
    const res = await fetch(`${API_URL}/api/auth/csrf`, {
      method: 'GET',
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (data?.csrfToken) {
      inMemoryCsrfToken = data.csrfToken;
      return inMemoryCsrfToken;
    }
  } catch {
    // Ignore transient CSRF fetch error
  }
  return null;
}

export function clearCsrfToken() {
  inMemoryCsrfToken = null;
}

export function setAccessToken(token) {
  inMemoryToken = token || null;
}

export function getAccessToken() {
  return inMemoryToken;
}

export function setUnauthorizedHandler(handler) {
  onUnauthorizedHandler = handler;
}

export function setTokenRefreshedHandler(handler) {
  onTokenRefreshedHandler = handler;
}

/**
 * Deduplicates concurrent /api/auth/refresh calls so multiple simultaneous 401s
 * trigger only a single refresh request.
 */
export async function refreshAccessToken() {
  if (inFlightRefreshPromise) {
    return inFlightRefreshPromise;
  }

  inFlightRefreshPromise = (async () => {
    try {
      const csrfToken = await ensureCsrfToken();
      const response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.token || !data?.user) {
        setAccessToken(null);
        return null;
      }

      setAccessToken(data.token);
      onTokenRefreshedHandler?.({ token: data.token, user: data.user });
      return data;
    } catch {
      setAccessToken(null);
      return null;
    } finally {
      inFlightRefreshPromise = null;
    }
  })();

  return inFlightRefreshPromise;
}

/**
 * Fetch wrapper that attaches the in-memory JWT, sends credentials for httpOnly
 * refresh cookies, and transparently refreshes + retries once on 401.
 */
export async function apiFetch(path, options = {}) {
  const { skipAuth = false, headers = {}, _retried = false, ...rest } = options;
  const versionedPath =
    path.startsWith('/api/') && !path.startsWith('/api/v1/') && !path.startsWith('/api/auth/')
      ? path.replace(/^\/api\//, '/api/v1/')
      : path;

  const requestHeaders = {
    'Content-Type': 'application/json',
    ...headers,
  };

  if (!skipAuth && inMemoryToken) {
    requestHeaders.Authorization = `Bearer ${inMemoryToken}`;
  }

  const response = await fetch(`${API_URL}${versionedPath}`, {
    ...rest,
    credentials: 'include',
    headers: requestHeaders,
  });

  if (response.status === 401 && !skipAuth && !_retried) {
    const refreshed = await refreshAccessToken();
    if (refreshed?.token) {
      return apiFetch(path, { ...options, _retried: true });
    }
    onUnauthorizedHandler?.();
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || `Request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;
}
