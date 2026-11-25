import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  apiFetch,
  getStoredAuth,
  setStoredAuth,
  setUnauthorizedHandler,
} from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(() => getStoredAuth());

  const logout = useCallback(() => {
    setStoredAuth(null);
    setAuth(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  const login = useCallback(async (username, password) => {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({ username, password }),
    });
    const nextAuth = { token: data.token, user: data.user };
    setStoredAuth(nextAuth);
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
    setStoredAuth(nextAuth);
    setAuth(nextAuth);
    return nextAuth;
  }, []);

  const value = useMemo(
    () => ({
      token: auth?.token ?? null,
      user: auth?.user ?? null,
      isAuthenticated: Boolean(auth?.token && auth?.user),
      login,
      register,
      logout,
    }),
    [auth, login, register, logout]
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
