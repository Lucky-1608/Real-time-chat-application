import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  apiFetch,
  ensureCsrfToken,
  refreshAccessToken,
  setAccessToken,
  setTokenRefreshedHandler,
  setUnauthorizedHandler,
} from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [signedOutNotice, setSignedOutNotice] = useState('');

  const clearAuth = useCallback(() => {
    setAccessToken(null);
    setAuth(null);
  }, []);

  const forceSignOut = useCallback(
    (message = 'You were signed out') => {
      setSignedOutNotice(message);
      clearAuth();
    },
    [clearAuth]
  );

  const logout = useCallback(async () => {
    try {
      const csrfToken = await ensureCsrfToken();
      await fetch(
        `${(import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/+$/, '')}/api/auth/logout`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          },
        }
      );
    } catch {
      // Ignore network errors during logout
    } finally {
      clearAuth();
    }
  }, [clearAuth]);

  const refreshSession = useCallback(async () => {
    const data = await refreshAccessToken();
    if (!data) {
      clearAuth();
      return null;
    }
    const nextAuth = { token: data.token, user: data.user };
    setAuth(nextAuth);
    return nextAuth;
  }, [clearAuth]);

  useEffect(() => {
    setUnauthorizedHandler(clearAuth);
    setTokenRefreshedHandler((next) => setAuth(next));
    return () => {
      setUnauthorizedHandler(null);
      setTokenRefreshedHandler(null);
    };
  }, [clearAuth]);

  // Restore session on app load using the httpOnly refresh cookie (no localStorage).
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      const data = await refreshAccessToken();
      if (!cancelled) {
        if (data?.token && data?.user) {
          setAuth({ token: data.token, user: data.user });
        }
        setInitializing(false);
      }
    }
    restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username, password) => {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({ username, password }),
    });
    if (data.mfaRequired) {
      return { mfaRequired: true, mfaToken: data.mfaToken };
    }
    const nextAuth = { token: data.token, user: data.user };
    setAccessToken(data.token);
    setSignedOutNotice('');
    setAuth(nextAuth);
    return nextAuth;
  }, []);

  const verifyMfa = useCallback(async ({ mfaToken, code, recoveryCode }) => {
    const data = await apiFetch('/api/auth/2fa/verify', {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({ mfaToken, code, recoveryCode }),
    });
    const nextAuth = { token: data.token, user: data.user };
    setAccessToken(data.token);
    setSignedOutNotice('');
    setAuth(nextAuth);
    return nextAuth;
  }, []);

  const updateUser = useCallback((patch) => {
    setAuth((prev) => (prev ? { ...prev, user: { ...prev.user, ...patch } } : prev));
  }, []);

  const register = useCallback(async (username, password) => {
    const data = await apiFetch('/api/auth/register', {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({ username, password }),
    });
    const nextAuth = { token: data.token, user: data.user };
    setAccessToken(data.token);
    setSignedOutNotice('');
    setAuth(nextAuth);
    return nextAuth;
  }, []);

  const value = useMemo(
    () => ({
      token: auth?.token ?? null,
      user: auth?.user ?? null,
      initializing,
      signedOutNotice,
      isAuthenticated: Boolean(auth?.token && auth?.user),
      login,
      verifyMfa,
      register,
      logout,
      forceSignOut,
      refreshSession,
      updateUser,
    }),
    [
      auth,
      initializing,
      signedOutNotice,
      login,
      verifyMfa,
      register,
      logout,
      forceSignOut,
      refreshSession,
      updateUser,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
