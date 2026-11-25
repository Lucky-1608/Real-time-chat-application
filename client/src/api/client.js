export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(
  /\/+$/,
  ''
);

const TOKEN_STORAGE_KEY = 'pulsechat_auth';

let onUnauthorizedHandler = null;

export function setUnauthorizedHandler(handler) {
  onUnauthorizedHandler = handler;
}

export function getStoredAuth() {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.token && parsed?.user) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function setStoredAuth(auth) {
  if (!auth) {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    return;
  }
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(auth));
}

/**
 * Fetch wrapper that attaches the stored JWT and triggers automatic logout
 * on HTTP 401 responses (except on auth endpoints where 401 means bad credentials).
 */
export async function apiFetch(path, options = {}) {
  const { skipAuth = false, headers = {}, ...rest } = options;
  const auth = getStoredAuth();

  const requestHeaders = {
    'Content-Type': 'application/json',
    ...headers,
  };

  if (!skipAuth && auth?.token) {
    requestHeaders.Authorization = `Bearer ${auth.token}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: requestHeaders,
  });

  const data = await response.json().catch(() => ({}));

  if (response.status === 401 && !skipAuth && typeof onUnauthorizedHandler === 'function') {
    onUnauthorizedHandler();
  }

  if (!response.ok) {
    const error = new Error(data.error || `Request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;
}
