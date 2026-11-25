import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL, apiFetch } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

const PAGE_SIZE = 50;

function mergeUniqueMessages(existing, incoming) {
  const byId = new Map();
  for (const msg of existing) {
    byId.set(msg._id, msg);
  }
  for (const msg of incoming) {
    byId.set(msg._id, { ...byId.get(msg._id), ...msg, status: 'sent' });
  }
  return Array.from(byId.values()).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

export function useChat() {
  const { token, user, logout } = useAuth();
  const socketRef = useRef(null);
  const hasConnectedOnceRef = useRef(false);
  const latestTimestampRef = useRef(null);

  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState(null);

  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]);
  const [userDirectory, setUserDirectory] = useState(() =>
    user?.id ? { [user.id]: user.username } : {}
  );

  // Keep latest confirmed message timestamp for reconnect catch-up.
  useEffect(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.status !== 'sending' && m.status !== 'failed' && m.createdAt) {
        latestTimestampRef.current = m.createdAt;
        break;
      }
    }
  }, [messages]);

  const registerUsers = useCallback((entries) => {
    setUserDirectory((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const { userId, username } of entries) {
        if (userId && username && next[userId] !== username) {
          next[userId] = username;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // Fetch initial message history
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    async function loadInitial() {
      setLoadingHistory(true);
      setHistoryError(null);
      try {
        const data = await apiFetch(`/api/messages?limit=${PAGE_SIZE}`);
        if (cancelled) return;
        setMessages(data.messages.map((m) => ({ ...m, status: 'sent' })));
        setHasMore(Boolean(data.hasMore));
        registerUsers(data.messages.map((m) => ({ userId: m.sender, username: m.senderName })));
      } catch (err) {
        if (!cancelled) {
          setHistoryError(err.message || 'Failed to load messages');
        }
      } finally {
        if (!cancelled) {
          setLoadingHistory(false);
        }
      }
    }

    loadInitial();
    return () => {
      cancelled = true;
    };
  }, [token, registerUsers]);

  // Own all socket lifecycle & event listeners; safe under React 18 StrictMode double-mount.
  useEffect(() => {
    if (!token) return;

    hasConnectedOnceRef.current = false;
    setConnectionStatus('connecting');

    const socket = io(API_URL, {
      auth: { token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    const handleConnect = async () => {
      setConnectionStatus('connected');

      // On reconnect, fetch any messages missed while offline and dedupe by _id.
      if (hasConnectedOnceRef.current && latestTimestampRef.current) {
        try {
          const data = await apiFetch(
            `/api/messages?after=${encodeURIComponent(latestTimestampRef.current)}&limit=100`
          );
          if (data.messages?.length > 0) {
            setMessages((prev) => mergeUniqueMessages(prev, data.messages));
            registerUsers(
              data.messages.map((m) => ({ userId: m.sender, username: m.senderName }))
            );
          }
        } catch {
          // Non-fatal: history can still be refreshed manually if catch-up fails.
        }
      }

      hasConnectedOnceRef.current = true;
    };

    const handleDisconnect = () => {
      setConnectionStatus('disconnected');
    };

    const handleReconnectAttempt = () => {
      setConnectionStatus('reconnecting');
    };

    const handleConnectError = (err) => {
      if (err?.message === 'unauthorized') {
        logout();
        return;
      }
      setConnectionStatus('reconnecting');
    };

    const handleMessageNew = (incoming) => {
      registerUsers([{ userId: incoming.sender, username: incoming.senderName }]);
      setMessages((prev) => {
        // Reconcile optimistic message if this is our own message arriving via broadcast.
        const optimisticIdx = prev.findIndex(
          (m) =>
            m.status === 'sending' &&
            m.sender === incoming.sender &&
            m.text === incoming.text
        );
        if (optimisticIdx !== -1) {
          const next = [...prev];
          next[optimisticIdx] = { ...incoming, status: 'sent' };
          return next;
        }
        return mergeUniqueMessages(prev, [incoming]);
      });
    };

    const handlePresenceList = (users) => {
      if (Array.isArray(users)) {
        setOnlineUsers(users);
        registerUsers(users);
      }
    };

    const handleTypingStart = ({ userId, username }) => {
      if (!userId || userId === user?.id) return;
      registerUsers([{ userId, username }]);
      setTypingUsers((prev) =>
        prev.some((u) => u.userId === userId) ? prev : [...prev, { userId, username }]
      );
    };

    const handleTypingStop = ({ userId }) => {
      setTypingUsers((prev) => prev.filter((u) => u.userId !== userId));
    };

    const handleMessageRead = ({ messageIds, userId, username }) => {
      if (!Array.isArray(messageIds) || !userId) return;
      if (username) {
        registerUsers([{ userId, username }]);
      }
      const idSet = new Set(messageIds);
      setMessages((prev) =>
        prev.map((m) => {
          if (!idSet.has(m._id)) return m;
          const existing = m.readBy || [];
          if (existing.includes(userId)) return m;
          return { ...m, readBy: [...existing, userId] };
        })
      );
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.io.on('reconnect_attempt', handleReconnectAttempt);
    socket.on('connect_error', handleConnectError);
    socket.on('message:new', handleMessageNew);
    socket.on('presence:list', handlePresenceList);
    socket.on('typing:start', handleTypingStart);
    socket.on('typing:stop', handleTypingStop);
    socket.on('message:read', handleMessageRead);

    return () => {
      socket.io.off('reconnect_attempt', handleReconnectAttempt);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, user?.id, logout, registerUsers]);

  const loadOlderMessages = useCallback(async () => {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    const oldest = messages[0];
    if (!oldest?.createdAt) return;

    setLoadingOlder(true);
    try {
      const data = await apiFetch(
        `/api/messages?before=${encodeURIComponent(oldest.createdAt)}&limit=${PAGE_SIZE}`
      );
      setMessages((prev) => mergeUniqueMessages(data.messages, prev));
      setHasMore(Boolean(data.hasMore));
      registerUsers(data.messages.map((m) => ({ userId: m.sender, username: m.senderName })));
    } catch (err) {
      setHistoryError(err.message || 'Failed to load older messages');
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, hasMore, messages, registerUsers]);

  const sendWithOptimism = useCallback(
    (text, existingTempId = null) => {
      const trimmed = text.trim();
      if (!trimmed || !user) return;

      const tempId =
        existingTempId || `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      if (existingTempId) {
        setMessages((prev) =>
          prev.map((m) => (m._id === existingTempId ? { ...m, status: 'sending', error: null } : m))
        );
      } else {
        const optimistic = {
          _id: tempId,
          sender: user.id,
          senderName: user.username,
          text: trimmed,
          readBy: [],
          createdAt: new Date().toISOString(),
          status: 'sending',
        };
        setMessages((prev) => [...prev, optimistic]);
      }

      const socket = socketRef.current;
      if (!socket || !socket.connected) {
        setMessages((prev) =>
          prev.map((m) =>
            m._id === tempId ? { ...m, status: 'failed', error: 'Not connected' } : m
          )
        );
        return;
      }

      socket.emit('message:send', { text: trimmed }, (ack) => {
        if (ack?.ok) {
          setMessages((prev) => {
            const alreadyConfirmed = prev.some((m) => m._id === ack.id);
            if (alreadyConfirmed) {
              return prev.filter((m) => m._id !== tempId);
            }
            return prev.map((m) =>
              m._id === tempId ? { ...m, _id: ack.id, status: 'sent', error: null } : m
            );
          });
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m._id === tempId
                ? { ...m, status: 'failed', error: ack?.error || 'Failed to send' }
                : m
            )
          );
        }
      });
    },
    [user]
  );

  const sendMessage = useCallback((text) => sendWithOptimism(text), [sendWithOptimism]);

  const retryMessage = useCallback(
    (tempId) => {
      const target = messages.find((m) => m._id === tempId);
      if (target) {
        sendWithOptimism(target.text, tempId);
      }
    },
    [messages, sendWithOptimism]
  );

  const emitTypingStart = useCallback(() => {
    socketRef.current?.emit('typing:start');
  }, []);

  const emitTypingStop = useCallback(() => {
    socketRef.current?.emit('typing:stop');
  }, []);

  const markMessagesRead = useCallback((messageIds) => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;
    if (socketRef.current?.connected) {
      socketRef.current.emit('message:read', { messageIds });
    }
  }, []);

  return {
    messages,
    hasMore,
    loadingHistory,
    loadingOlder,
    historyError,
    connectionStatus,
    onlineUsers,
    typingUsers,
    userDirectory,
    loadOlderMessages,
    sendMessage,
    retryMessage,
    emitTypingStart,
    emitTypingStop,
    markMessagesRead,
  };
}
