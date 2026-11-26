import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  apiFetch,
  refreshAccessToken,
  setAccessToken,
  setTokenRefreshedHandler,
  setUnauthorizedHandler,
} from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(null);
  const [initializing, setInitializing] = useState(true);

  const clearAuth = useCallback(() => {
    setAccessToken(null);
    setAuth(null);
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch(
        `${(import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/+$/, '')}/api/auth/logout`,
        {
          method: 'POST',
          credentials: 'include',
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
    const nextAuth = { token: data.token, user: data.user };
    setAccessToken(data.token);
    setAuth(nextAuth);
    return nextAuth;
  }, []);

  const register = useCallback(async (username, password) => {
    const data = await apiFetch('/api/auth/register', {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({ username, password }),
    });
    const nextAuth = { token: data.token, user: data.user };
    setAccessToken(data.token);
    setAuth(nextAuth);
    return nextAuth;
  }, []);

  const value = useMemo(
    () => ({
      token: auth?.token ?? null,
      user: auth?.user ?? null,
      initializing,
      isAuthenticated: Boolean(auth?.token && auth?.user),
      login,
      register,
      logout,
      refreshSession,
    }),
    [auth, initializing, login, register, logout, refreshSession]
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
