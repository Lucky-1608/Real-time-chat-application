/**
 * Tracks active WebSocket connections per userId so closing one of several
 * open browser tabs does not prematurely mark the user as offline.
 */
export function createPresenceTracker() {
  const onlineUsers = new Map();

  function addConnection(userId, username) {
    const existing = onlineUsers.get(userId);
    if (existing) {
      existing.count += 1;
      existing.username = username;
      return false;
    }
    onlineUsers.set(userId, { userId, username, count: 1 });
    return true;
  }

  function removeConnection(userId) {
    const existing = onlineUsers.get(userId);
    if (!existing) return false;
    existing.count -= 1;
    if (existing.count <= 0) {
      onlineUsers.delete(userId);
      return true;
    }
    return false;
  }

  function getOnlineUsers() {
    return Array.from(onlineUsers.values()).map(({ userId, username }) => ({
      userId,
      username,
    }));
  }

  return {
    addConnection,
    removeConnection,
    getOnlineUsers,
  };
}
