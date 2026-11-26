import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL, apiFetch, getAccessToken } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

const PAGE_SIZE = 50;
const ROOM_PATH_REGEX = /^\/rooms\/([a-f0-9]{24})$/i;

function parseRoomIdFromUrl() {
  const match = window.location.pathname.match(ROOM_PATH_REGEX);
  return match ? match[1] : null;
}

function mergeUniqueMessages(existing = [], incoming = []) {
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

function sortRoomsByActivity(rooms) {
  return [...rooms].sort((a, b) => {
    const tA = new Date(a.lastMessage?.createdAt || a.updatedAt || 0).getTime();
    const tB = new Date(b.lastMessage?.createdAt || b.updatedAt || 0).getTime();
    return tB - tA;
  });
}

export function useChat() {
  const { token, user, logout, forceSignOut, refreshSession } = useAuth();
  const socketRef = useRef(null);
  const hasConnectedOnceRef = useRef(false);

  const [rooms, setRooms] = useState([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [activeRoomId, setActiveRoomId] = useState(() => parseRoomIdFromUrl());

  const [messagesByRoom, setMessagesByRoom] = useState({});
  const [hasMoreByRoom, setHasMoreByRoom] = useState({});
  const [draftsByRoom, setDraftsByRoom] = useState({});
  const [highlightedMessageId, setHighlightedMessageId] = useState(null);
  const [userStatuses, setUserStatuses] = useState({});
  const [starredMessages, setStarredMessages] = useState([]);
  const draftTimersRef = useRef({});
  const [loadingByRoom, setLoadingByRoom] = useState({});
  const [loadingOlderByRoom, setLoadingOlderByRoom] = useState({});
  const [errorByRoom, setErrorByRoom] = useState({});

  const [typingByRoom, setTypingByRoom] = useState({});
  const [unreadByRoom, setUnreadByRoom] = useState({});
  const [summaryByRoom, setSummaryByRoom] = useState({});
  const [summaryLoadingByRoom, setSummaryLoadingByRoom] = useState({});
  const [summaryErrorByRoom, setSummaryErrorByRoom] = useState({});
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [userDirectory, setUserDirectory] = useState(() =>
    user?.id ? { [user.id]: user.username } : {}
  );

  const activeRoomIdRef = useRef(activeRoomId);
  activeRoomIdRef.current = activeRoomId;

  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;

  const messagesByRoomRef = useRef(messagesByRoom);
  messagesByRoomRef.current = messagesByRoom;

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

  const selectRoom = useCallback((roomId, { replace = false } = {}) => {
    if (!roomId) return;
    setActiveRoomId(roomId);
    const targetPath = `/rooms/${roomId}`;
    if (window.location.pathname !== targetPath) {
      if (replace) {
        window.history.replaceState({ roomId }, '', targetPath);
      } else {
        window.history.pushState({ roomId }, '', targetPath);
      }
    }
  }, []);

  // Sync activeRoomId with browser back/forward navigation.
  useEffect(() => {
    const handlePopState = () => {
      const fromUrl = parseRoomIdFromUrl();
      if (fromUrl) {
        setActiveRoomId(fromUrl);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Update document title with total unread count across all rooms.
  useEffect(() => {
    const totalUnread = Object.values(unreadByRoom).reduce((sum, n) => sum + (n || 0), 0);
    document.title = totalUnread > 0 ? `(${totalUnread}) PulseChat` : 'PulseChat';
    return () => {
      document.title = 'PulseChat';
    };
  }, [unreadByRoom]);

  // Fetch user's room list on mount / login.
  const refreshRooms = useCallback(async () => {
    if (!token) return;
    setRoomsLoading(true);
    try {
      const data = await apiFetch('/api/rooms');
      const fetchedRooms = data.rooms || [];
      setRooms(sortRoomsByActivity(fetchedRooms));

      const nextUnread = {};
      const dirEntries = [];
      for (const r of fetchedRooms) {
        nextUnread[r._id] = r.unreadCount || 0;
        for (const m of r.members || []) {
          if (m.user?.id && m.user?.username) {
            dirEntries.push({ userId: m.user.id, username: m.user.username });
          }
        }
      }
      setUnreadByRoom((prev) => ({ ...prev, ...nextUnread }));
      registerUsers(dirEntries);

      const urlId = parseRoomIdFromUrl();
      const hasUrlRoom = urlId && fetchedRooms.some((r) => r._id === urlId);
      if (hasUrlRoom) {
        setActiveRoomId(urlId);
      } else if (fetchedRooms.length > 0) {
        const general = fetchedRooms.find(
          (r) => r.type === 'public' && r.name?.toLowerCase() === 'general'
        );
        const fallback = general || fetchedRooms[0];
        selectRoom(fallback._id, { replace: true });
      }
    } finally {
      setRoomsLoading(false);
    }
  }, [token, registerUsers, selectRoom]);

  useEffect(() => {
    refreshRooms();
  }, [refreshRooms]);

  // Load or catch up messages when switching activeRoomId.
  useEffect(() => {
    if (!token || !activeRoomId) return;
    let cancelled = false;

    async function syncActiveRoomMessages() {
      const cached = messagesByRoomRef.current[activeRoomId];
      const latestConfirmed = cached
        ? [...cached].reverse().find((m) => m.status !== 'sending' && m.status !== 'failed')
        : null;

      if (!cached) {
        setLoadingByRoom((prev) => ({ ...prev, [activeRoomId]: true }));
        setErrorByRoom((prev) => ({ ...prev, [activeRoomId]: null }));
        try {
          const data = await apiFetch(`/api/rooms/${activeRoomId}/messages?limit=${PAGE_SIZE}`);
          if (cancelled) return;
          const normalized = (data.messages || []).map((m) => ({ ...m, status: 'sent' }));
          setMessagesByRoom((prev) => ({
            ...prev,
            [activeRoomId]: mergeUniqueMessages(prev[activeRoomId], normalized),
          }));
          setHasMoreByRoom((prev) => ({ ...prev, [activeRoomId]: Boolean(data.hasMore) }));
          registerUsers(normalized.map((m) => ({ userId: m.sender, username: m.senderName })));
        } catch (err) {
          if (!cancelled) {
            setErrorByRoom((prev) => ({
              ...prev,
              [activeRoomId]: err.message || 'Failed to load messages',
            }));
          }
        } finally {
          if (!cancelled) {
            setLoadingByRoom((prev) => ({ ...prev, [activeRoomId]: false }));
          }
        }
      } else if (latestConfirmed) {
        const sinceCursor = latestConfirmed.updatedAt || latestConfirmed.createdAt;
        if (!sinceCursor) return;
        // Show cached messages instantly and fetch new, edited, or deleted messages since cursor.
        try {
          const data = await apiFetch(
            `/api/rooms/${activeRoomId}/changes?since=${encodeURIComponent(sinceCursor)}`
          );
          if (cancelled || !data.changes?.length) return;
          setMessagesByRoom((prev) => ({
            ...prev,
            [activeRoomId]: mergeUniqueMessages(prev[activeRoomId], data.changes),
          }));
          registerUsers(data.changes.map((m) => ({ userId: m.sender, username: m.senderName })));
        } catch {
          // Non-fatal catch-up error
        }
      }
    }

    syncActiveRoomMessages();
    return () => {
      cancelled = true;
    };
  }, [token, activeRoomId, registerUsers]);

  // Single Socket.io connection per tab, shared across all rooms.
  useEffect(() => {
    const initialToken = getAccessToken();
    if (!user?.id || !initialToken) return;

    hasConnectedOnceRef.current = false;
    setConnectionStatus('connecting');

    const socket = io(API_URL, {
      auth: { token: initialToken },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    const handleConnect = async () => {
      setConnectionStatus('connected');

      if (hasConnectedOnceRef.current) {
        // Re-subscribe and catch up missed messages across all rooms on reconnect.
        const currentRooms = roomsRef.current;
        await Promise.all(
          currentRooms.map(async (r) => {
            socket.emit('room:subscribe', { roomId: r._id });
            const cached = messagesByRoomRef.current[r._id] || [];
            let maxUpdated = null;
            for (const m of cached) {
              if (m.status === 'sending' || m.status === 'failed') continue;
              const ts = m.updatedAt || m.createdAt;
              if (ts && (!maxUpdated || new Date(ts) > new Date(maxUpdated))) {
                maxUpdated = ts;
              }
            }
            if (!maxUpdated) return;
            try {
              const data = await apiFetch(
                `/api/rooms/${r._id}/changes?since=${encodeURIComponent(maxUpdated)}`
              );
              if (data.changes?.length > 0) {
                setMessagesByRoom((prev) => ({
                  ...prev,
                  [r._id]: mergeUniqueMessages(prev[r._id], data.changes),
                }));
              }
            } catch {
              // Ignore transient catch-up error for individual room
            }
          })
        );
      }

      hasConnectedOnceRef.current = true;
    };

    const handleDisconnect = () => setConnectionStatus('disconnected');
    const handleReconnectAttempt = () => setConnectionStatus('reconnecting');
    const handleConnectError = async (err) => {
      if (err?.message === 'unauthorized') {
        const refreshed = await refreshSession();
        if (refreshed?.token) {
          socket.auth = { token: refreshed.token };
          socket.connect();
          return;
        }
        logout();
        return;
      }
      setConnectionStatus('reconnecting');
    };

    const handleAuthExpired = async () => {
      const refreshed = await refreshSession();
      if (refreshed?.token && socket.connected) {
        socket.emit('auth:refresh', { token: refreshed.token });
      } else {
        logout();
      }
    };

    const handleSessionRevoked = (payload) => {
      forceSignOut(payload?.reason || 'You were signed out');
    };

    const handleMessageNew = (incoming) => {
      const rId = incoming.room;
      registerUsers([{ userId: incoming.sender, username: incoming.senderName }]);

      setMessagesByRoom((prev) => {
        const current = prev[rId] || [];
        const optimisticIdx = current.findIndex(
          (m) => m.status === 'sending' && m.sender === incoming.sender && m.text === incoming.text
        );
        if (optimisticIdx !== -1) {
          const next = [...current];
          next[optimisticIdx] = { ...incoming, status: 'sent' };
          return { ...prev, [rId]: next };
        }
        return { ...prev, [rId]: mergeUniqueMessages(current, [incoming]) };
      });

      setRooms((prev) =>
        sortRoomsByActivity(
          prev.map((r) => (r._id === rId ? { ...r, lastMessage: incoming } : r))
        )
      );
    };

    const handleMessageUpdated = (updated) => {
      const rId = updated.room;
      setMessagesByRoom((prev) => ({
        ...prev,
        [rId]: mergeUniqueMessages(prev[rId], [updated]),
      }));
      setRooms((prev) =>
        prev.map((r) =>
          r._id === rId && r.lastMessage?._id === updated._id ? { ...r, lastMessage: updated } : r
        )
      );
    };

    const handleMessageDeleted = ({ roomId, messageId, deletedAt }) => {
      if (!roomId || !messageId) return;
      setMessagesByRoom((prev) => {
        const list = prev[roomId];
        if (!list) return prev;
        return {
          ...prev,
          [roomId]: list.map((m) =>
            m._id === messageId
              ? { ...m, text: '', deletedAt, updatedAt: deletedAt, editedAt: null, reactions: [] }
              : m
          ),
        };
      });
      setRooms((prev) =>
        prev.map((r) =>
          r._id === roomId && r.lastMessage?._id === messageId
            ? {
                ...r,
                lastMessage: { ...r.lastMessage, text: '', deletedAt, editedAt: null },
              }
            : r
        )
      );
    };

    const handleReactionUpdated = ({ roomId, messageId, reactions }) => {
      if (!roomId || !messageId || !Array.isArray(reactions)) return;
      setMessagesByRoom((prev) => {
        const list = prev[roomId];
        if (!list) return prev;
        return {
          ...prev,
          [roomId]: list.map((m) => (m._id === messageId ? { ...m, reactions } : m)),
        };
      });
    };

    const handleAttachmentStatus = ({
      roomId,
      messageId,
      attachmentKey,
      newKey,
      status,
      url,
      size,
      reason,
    }) => {
      if (!roomId || !messageId || !attachmentKey) return;
      setMessagesByRoom((prev) => {
        const list = prev[roomId];
        if (!list) return prev;
        return {
          ...prev,
          [roomId]: list.map((m) => {
            if (m._id !== messageId) return m;
            return {
              ...m,
              attachments: (m.attachments || []).map((att) =>
                att.key === attachmentKey
                  ? {
                      ...att,
                      key: newKey || att.key,
                      scanStatus: status,
                      url: status === 'clean' ? url || null : null,
                      size: size ?? att.size,
                      scanReason: reason || null,
                    }
                  : att
              ),
            };
          }),
        };
      });
    };

    const handlePresenceList = (users) => {
      if (Array.isArray(users)) {
        setOnlineUsers(users);
        registerUsers(users);
      }
    };

    const handleTypingStart = ({ roomId, userId, username }) => {
      if (!roomId || !userId || userId === user?.id) return;
      registerUsers([{ userId, username }]);
      setTypingByRoom((prev) => {
        const list = prev[roomId] || [];
        if (list.some((u) => u.userId === userId)) return prev;
        return { ...prev, [roomId]: [...list, { userId, username }] };
      });
    };

    const handleTypingStop = ({ roomId, userId }) => {
      if (!roomId || !userId) return;
      setTypingByRoom((prev) => {
        const list = prev[roomId];
        if (!list) return prev;
        return { ...prev, [roomId]: list.filter((u) => u.userId !== userId) };
      });
    };

    const handleMessageRead = ({ roomId, messageIds, userId, username }) => {
      if (!roomId || !Array.isArray(messageIds) || !userId) return;
      if (username) registerUsers([{ userId, username }]);
      const idSet = new Set(messageIds);
      setMessagesByRoom((prev) => {
        const list = prev[roomId];
        if (!list) return prev;
        return {
          ...prev,
          [roomId]: list.map((m) => {
            if (!idSet.has(m._id)) return m;
            const existing = m.readBy || [];
            if (existing.includes(userId)) return m;
            return { ...m, readBy: [...existing, userId] };
          }),
        };
      });
    };

    const handleRoomUnread = ({ roomId, unreadCount }) => {
      if (!roomId) return;
      setUnreadByRoom((prev) => ({ ...prev, [roomId]: unreadCount }));
    };

    const handleRoomCreated = ({ room }) => {
      if (!room?._id) return;
      setRooms((prev) => {
        if (prev.some((r) => r._id === room._id)) return prev;
        return sortRoomsByActivity([room, ...prev]);
      });
      setUnreadByRoom((prev) => ({ ...prev, [room._id]: room.unreadCount || 0 }));
    };

    const handleRoomJoined = ({ room, roomId, user: joinedUser }) => {
      if (room?._id) {
        handleRoomCreated({ room });
      } else if (roomId && joinedUser) {
        setRooms((prev) =>
          prev.map((r) => {
            if (r._id !== roomId) return r;
            if (r.members?.some((m) => m.user?.id === joinedUser.id)) return r;
            return {
              ...r,
              members: [...(r.members || []), { user: joinedUser, role: 'member' }],
            };
          })
        );
      }
    };

    const handleRoomLeft = ({ roomId, userId: leftUserId, deleted }) => {
      if (!roomId) return;
      if (deleted || !leftUserId || leftUserId === user?.id) {
        setRooms((prev) => {
          const remaining = prev.filter((r) => r._id !== roomId);
          if (activeRoomIdRef.current === roomId && remaining.length > 0) {
            const general = remaining.find(
              (r) => r.type === 'public' && r.name?.toLowerCase() === 'general'
            );
            selectRoom((general || remaining[0])._id, { replace: true });
          }
          return remaining;
        });
        setUnreadByRoom((prev) => {
          const next = { ...prev };
          delete next[roomId];
          return next;
        });
      } else {
        setRooms((prev) =>
          prev.map((r) =>
            r._id === roomId
              ? { ...r, members: (r.members || []).filter((m) => m.user?.id !== leftUserId) }
              : r
          )
        );
      }
    };

    const handleMemberUpdated = ({ roomId, members }) => {
      if (!roomId || !Array.isArray(members)) return;
      setRooms((prev) =>
        prev.map((r) => (r._id === roomId ? { ...r, members } : r))
      );
    };

    const handleDraftUpdated = ({ roomId, text }) => {
      if (!roomId) return;
      setDraftsByRoom((prev) => ({ ...prev, [roomId]: text || '' }));
    };

    const handlePinsUpdated = ({ roomId, pinnedMessages }) => {
      if (!roomId || !Array.isArray(pinnedMessages)) return;
      setRooms((prev) =>
        prev.map((r) => (r._id === roomId ? { ...r, pinnedMessages } : r))
      );
    };

    const handleUserStatusUpdated = ({ userId: uid, customStatus, dnd }) => {
      if (!uid) return;
      setUserStatuses((prev) => ({ ...prev, [uid]: { customStatus, dnd } }));
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.io.on('reconnect_attempt', handleReconnectAttempt);
    socket.on('connect_error', handleConnectError);
    socket.on('auth:expired', handleAuthExpired);
    socket.on('session:revoked', handleSessionRevoked);
    socket.on('message:new', handleMessageNew);
    socket.on('message:updated', handleMessageUpdated);
    socket.on('message:deleted', handleMessageDeleted);
    socket.on('reaction:updated', handleReactionUpdated);
    socket.on('attachment:status', handleAttachmentStatus);
    socket.on('presence:list', handlePresenceList);
    socket.on('typing:start', handleTypingStart);
    socket.on('typing:stop', handleTypingStop);
    socket.on('message:read', handleMessageRead);
    socket.on('room:unread', handleRoomUnread);
    socket.on('room:created', handleRoomCreated);
    socket.on('room:joined', handleRoomJoined);
    socket.on('room:left', handleRoomLeft);
    socket.on('member:updated', handleMemberUpdated);
    socket.on('draft:updated', handleDraftUpdated);
    socket.on('room:pins_updated', handlePinsUpdated);
    socket.on('user:status_updated', handleUserStatusUpdated);

    return () => {
      socket.io.off('reconnect_attempt', handleReconnectAttempt);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [user?.id, logout, forceSignOut, refreshSession, registerUsers, selectRoom]);

  const loadOlderMessages = useCallback(async () => {
    const rId = activeRoomId;
    if (!rId || loadingOlderByRoom[rId] || !hasMoreByRoom[rId]) return;
    const currentMsgs = messagesByRoom[rId] || [];
    if (currentMsgs.length === 0) return;
    const oldest = currentMsgs[0];
    if (!oldest?.createdAt) return;

    setLoadingOlderByRoom((prev) => ({ ...prev, [rId]: true }));
    try {
      const data = await apiFetch(
        `/api/rooms/${rId}/messages?before=${encodeURIComponent(oldest.createdAt)}&limit=${PAGE_SIZE}`
      );
      setMessagesByRoom((prev) => ({
        ...prev,
        [rId]: mergeUniqueMessages(data.messages, prev[rId]),
      }));
      setHasMoreByRoom((prev) => ({ ...prev, [rId]: Boolean(data.hasMore) }));
      registerUsers((data.messages || []).map((m) => ({ userId: m.sender, username: m.senderName })));
    } catch (err) {
      setErrorByRoom((prev) => ({ ...prev, [rId]: err.message || 'Failed to load older messages' }));
    } finally {
      setLoadingOlderByRoom((prev) => ({ ...prev, [rId]: false }));
    }
  }, [activeRoomId, loadingOlderByRoom, hasMoreByRoom, messagesByRoom, registerUsers]);

  const sendWithOptimism = useCallback(
    (text, existingTempId = null, attachments = []) => {
      const trimmed = (text || '').trim();
      const rId = activeRoomIdRef.current;
      if ((!trimmed && (!attachments || attachments.length === 0)) || !user || !rId) return;

      const tempId =
        existingTempId || `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      if (existingTempId) {
        setMessagesByRoom((prev) => ({
          ...prev,
          [rId]: (prev[rId] || []).map((m) =>
            m._id === existingTempId ? { ...m, status: 'sending', error: null } : m
          ),
        }));
      } else {
        const optimistic = {
          _id: tempId,
          room: rId,
          sender: user.id,
          senderName: user.username,
          text: trimmed,
          attachments,
          readBy: [],
          createdAt: new Date().toISOString(),
          status: 'sending',
        };
        setMessagesByRoom((prev) => ({
          ...prev,
          [rId]: [...(prev[rId] || []), optimistic],
        }));
      }

      const socket = socketRef.current;
      if (!socket || !socket.connected) {
        setMessagesByRoom((prev) => ({
          ...prev,
          [rId]: (prev[rId] || []).map((m) =>
            m._id === tempId ? { ...m, status: 'failed', error: 'Not connected' } : m
          ),
        }));
        return;
      }

      const cleanAttachments = attachments.map(({ key, name, contentType, size }) => ({
        key,
        name,
        contentType,
        size,
      }));

      socket.emit(
        'message:send',
        { roomId: rId, text: trimmed, attachments: cleanAttachments },
        (ack) => {
          if (ack?.ok) {
            setMessagesByRoom((prev) => {
              const list = prev[rId] || [];
              const alreadyConfirmed = list.some((m) => m._id === ack.id);
              if (alreadyConfirmed) {
                return { ...prev, [rId]: list.filter((m) => m._id !== tempId) };
              }
              return {
                ...prev,
                [rId]: list.map((m) =>
                  m._id === tempId ? { ...m, _id: ack.id, status: 'sent', error: null } : m
                ),
              };
            });
          } else {
            setMessagesByRoom((prev) => ({
              ...prev,
              [rId]: (prev[rId] || []).map((m) =>
                m._id === tempId
                  ? { ...m, status: 'failed', error: ack?.error || 'Failed to send' }
                  : m
              ),
            }));
          }
        }
      );
    },
    [user]
  );

  const sendMessage = useCallback(
    (text, attachments = []) => sendWithOptimism(text, null, attachments),
    [sendWithOptimism]
  );

  const retryMessage = useCallback(
    (tempId) => {
      const list = messagesByRoom[activeRoomId] || [];
      const target = list.find((m) => m._id === tempId);
      if (target) sendWithOptimism(target.text, tempId, target.attachments || []);
    },
    [activeRoomId, messagesByRoom, sendWithOptimism]
  );

  const emitTypingStart = useCallback(() => {
    if (activeRoomIdRef.current) {
      socketRef.current?.emit('typing:start', { roomId: activeRoomIdRef.current });
    }
  }, []);

  const emitTypingStop = useCallback(() => {
    if (activeRoomIdRef.current) {
      socketRef.current?.emit('typing:stop', { roomId: activeRoomIdRef.current });
    }
  }, []);

  const markMessagesRead = useCallback((roomId, messageIds) => {
    if (!roomId || !Array.isArray(messageIds) || messageIds.length === 0) return;
    setUnreadByRoom((prev) => ({ ...prev, [roomId]: 0 }));
    if (socketRef.current?.connected) {
      socketRef.current.emit('message:read', { roomId, messageIds });
    }
  }, []);

  const editMessage = useCallback((roomId, messageId, text) => {
    return new Promise((resolve, reject) => {
      if (!socketRef.current?.connected) {
        reject(new Error('Not connected'));
        return;
      }
      socketRef.current.emit('message:edit', { roomId, messageId, text }, (ack) => {
        if (ack?.ok) {
          resolve();
        } else {
          reject(new Error(ack?.error || 'Failed to edit message'));
        }
      });
    });
  }, []);

  const deleteMessage = useCallback((roomId, messageId) => {
    return new Promise((resolve, reject) => {
      if (!socketRef.current?.connected) {
        reject(new Error('Not connected'));
        return;
      }
      socketRef.current.emit('message:delete', { roomId, messageId }, (ack) => {
        if (ack?.ok) {
          resolve();
        } else {
          reject(new Error(ack?.error || 'Failed to delete message'));
        }
      });
    });
  }, []);

  const toggleReaction = useCallback((roomId, messageId, emoji) => {
    if (!roomId || !messageId || !emoji || !socketRef.current?.connected) return;
    socketRef.current.emit('reaction:toggle', { roomId, messageId, emoji });
  }, []);

  // Room management actions
  const createRoom = useCallback(
    async ({ name, type, memberIds }) => {
      const data = await apiFetch('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ name, type, memberIds }),
      });
      setRooms((prev) => {
        if (prev.some((r) => r._id === data.room._id)) return prev;
        return sortRoomsByActivity([data.room, ...prev]);
      });
      selectRoom(data.room._id);
      return data.room;
    },
    [selectRoom]
  );

  const startDm = useCallback(
    async (userId) => {
      const data = await apiFetch('/api/rooms/dm', {
        method: 'POST',
        body: JSON.stringify({ userId }),
      });
      setRooms((prev) => {
        if (prev.some((r) => r._id === data.room._id)) return prev;
        return sortRoomsByActivity([data.room, ...prev]);
      });
      selectRoom(data.room._id);
      return data.room;
    },
    [selectRoom]
  );

  const joinPublicRoom = useCallback(
    async (roomId) => {
      const data = await apiFetch(`/api/rooms/${roomId}/join`, { method: 'POST' });
      setRooms((prev) => {
        if (prev.some((r) => r._id === data.room._id)) return prev;
        return sortRoomsByActivity([data.room, ...prev]);
      });
      selectRoom(data.room._id);
      return data.room;
    },
    [selectRoom]
  );

  const inviteMembers = useCallback(async (roomId, memberIds) => {
    const data = await apiFetch(`/api/rooms/${roomId}/members`, {
      method: 'POST',
      body: JSON.stringify({ memberIds }),
    });
    setRooms((prev) => prev.map((r) => (r._id === roomId ? data.room : r)));
    return data.room;
  }, []);

  const leaveRoom = useCallback(async (roomId) => {
    await apiFetch(`/api/rooms/${roomId}/members/me`, { method: 'DELETE' });
  }, []);

  const deleteRoom = useCallback(async (roomId) => {
    await apiFetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
  }, []);

  const changeMemberRole = useCallback(async (roomId, targetUserId, role) => {
    const data = await apiFetch(`/api/rooms/${roomId}/members/${targetUserId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
    setRooms((prev) => prev.map((r) => (r._id === roomId ? data.room : r)));
    return data.room;
  }, []);

  const removeMember = useCallback(async (roomId, targetUserId) => {
    await apiFetch(`/api/rooms/${roomId}/members/${targetUserId}`, {
      method: 'DELETE',
    });
  }, []);

  const jumpToMessage = useCallback(
    async (roomId, messageId) => {
      if (!roomId || !messageId) return;
      selectRoom(roomId);
      const data = await apiFetch(
        `/api/rooms/${roomId}/messages?around=${encodeURIComponent(messageId)}&limit=${PAGE_SIZE}`
      );
      setMessagesByRoom((prev) => ({ ...prev, [roomId]: data.messages || [] }));
      setHasMoreByRoom((prev) => ({ ...prev, [roomId]: Boolean(data.hasMoreOlder) }));
      setHighlightedMessageId(messageId);
      setTimeout(() => {
        setHighlightedMessageId((cur) => (cur === messageId ? null : cur));
      }, 2500);
    },
    [selectRoom]
  );

  const saveDraft = useCallback((roomId, text) => {
    if (!roomId) return;
    setDraftsByRoom((prev) => ({ ...prev, [roomId]: text }));
    if (draftTimersRef.current[roomId]) {
      clearTimeout(draftTimersRef.current[roomId]);
    }
    draftTimersRef.current[roomId] = setTimeout(() => {
      apiFetch(`/api/rooms/${roomId}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ text }),
      }).catch(() => {});
    }, 800);
  }, []);

  const pinMessage = useCallback(async (roomId, messageId) => {
    await apiFetch(`/api/rooms/${roomId}/pins/${messageId}`, { method: 'POST' });
  }, []);

  const unpinMessage = useCallback(async (roomId, messageId) => {
    await apiFetch(`/api/rooms/${roomId}/pins/${messageId}`, { method: 'DELETE' });
  }, []);

  const toggleStar = useCallback(async (messageId, isStarred) => {
    await apiFetch(`/api/messages/${messageId}/star`, {
      method: isStarred ? 'DELETE' : 'POST',
    });
  }, []);

  const loadStarredMessages = useCallback(async () => {
    const data = await apiFetch('/api/users/me/stars');
    setStarredMessages(data.stars || []);
    return data.stars || [];
  }, []);

  const setNotificationLevel = useCallback(async (roomId, level) => {
    await apiFetch(`/api/rooms/${roomId}/notifications`, {
      method: 'PATCH',
      body: JSON.stringify({ level }),
    });
    setRooms((prev) =>
      prev.map((r) =>
        r._id === roomId
          ? {
              ...r,
              members: (r.members || []).map((m) =>
                m.user?.id === user?.id
                  ? { ...m, notificationLevel: level, muted: level === 'muted' }
                  : m
              ),
            }
          : r
      )
    );
  }, [user?.id]);

  const updateUserStatus = useCallback(async (payload) => {
    return apiFetch('/api/users/me/status', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }, []);

  const requestSummary = useCallback(async (roomId, { force = false } = {}) => {
    if (!roomId) return;
    setSummaryLoadingByRoom((prev) => ({ ...prev, [roomId]: true }));
    setSummaryErrorByRoom((prev) => ({ ...prev, [roomId]: null }));
    try {
      const data = await apiFetch(`/api/rooms/${roomId}/summary`, {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
      setSummaryByRoom((prev) => ({ ...prev, [roomId]: data }));
    } catch (err) {
      setSummaryErrorByRoom((prev) => ({
        ...prev,
        [roomId]: err.message || 'Failed to generate summary',
      }));
    } finally {
      setSummaryLoadingByRoom((prev) => ({ ...prev, [roomId]: false }));
    }
  }, []);

  const dismissSummary = useCallback((roomId) => {
    if (!roomId) return;
    setSummaryByRoom((prev) => ({ ...prev, [roomId]: null }));
    setSummaryErrorByRoom((prev) => ({ ...prev, [roomId]: null }));
  }, []);

  const activeRoom = useMemo(
    () => rooms.find((r) => r._id === activeRoomId) || null,
    [rooms, activeRoomId]
  );

  return {
    rooms,
    roomsLoading,
    activeRoomId,
    activeRoom,
    selectRoom,
    messages: messagesByRoom[activeRoomId] || [],
    hasMore: Boolean(hasMoreByRoom[activeRoomId]),
    loadingHistory: Boolean(loadingByRoom[activeRoomId]),
    loadingOlder: Boolean(loadingOlderByRoom[activeRoomId]),
    historyError: errorByRoom[activeRoomId] || null,
    typingUsers: typingByRoom[activeRoomId] || [],
    unreadByRoom,
    summary: summaryByRoom[activeRoomId] || null,
    summaryLoading: Boolean(summaryLoadingByRoom[activeRoomId]),
    summaryError: summaryErrorByRoom[activeRoomId] || null,
    connectionStatus,
    onlineUsers,
    userDirectory,
    loadOlderMessages,
    sendMessage,
    retryMessage,
    emitTypingStart,
    emitTypingStop,
    markMessagesRead,
    editMessage,
    deleteMessage,
    toggleReaction,
    createRoom,
    startDm,
    joinPublicRoom,
    inviteMembers,
    leaveRoom,
    deleteRoom,
    changeMemberRole,
    removeMember,
    draftsByRoom,
    highlightedMessageId,
    userStatuses,
    starredMessages,
    jumpToMessage,
    saveDraft,
    pinMessage,
    unpinMessage,
    toggleStar,
    loadStarredMessages,
    setNotificationLevel,
    updateUserStatus,
    requestSummary,
    dismissSummary,
  };
}
