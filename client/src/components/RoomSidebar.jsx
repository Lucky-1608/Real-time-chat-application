import styles from './RoomSidebar.module.css';

export default function RoomSidebar({
  workspaces = [],
  activeWorkspace = null,
  onSwitchWorkspace,
  onCreateWorkspace,
  rooms,
  activeRoomId,
  unreadByRoom,
  onlineUserIds,
  isOpen,
  onClose,
  onSelectRoom,
  onOpenCreateRoom,
  onOpenBrowseRooms,
  onOpenNewDm,
}) {
  const channelRooms = rooms.filter((r) => r.type !== 'dm');
  const dmRooms = rooms.filter((r) => r.type === 'dm');

  function handleSelect(roomId) {
    onSelectRoom(roomId);
    onClose();
  }

  return (
    <nav
      className={`${styles.sidebar} ${isOpen ? styles.open : ''}`}
      aria-label="Chat rooms and direct messages"
    >
      <div className={styles.mobileHeader}>
        <span className={styles.brand}>PulseChat</span>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close navigation"
        >
          ×
        </button>
      </div>

      {workspaces.length > 0 && (
        <div
          className={styles.section}
          style={{
            padding: '0.5rem 0.75rem',
            borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))',
            display: 'flex',
            gap: '0.4rem',
            alignItems: 'center',
          }}
        >
          <select
            aria-label="Switch workspace"
            value={activeWorkspace?._id || ''}
            onChange={(e) => onSwitchWorkspace?.(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '0.3rem 0.45rem',
              borderRadius: '6px',
              background: 'var(--bg-elevated, rgba(255,255,255,0.06))',
              color: 'inherit',
              border: '1px solid var(--border, rgba(255,255,255,0.12))',
              fontSize: '0.85rem',
            }}
          >
            {workspaces.map((ws) => (
              <option key={ws._id} value={ws._id}>
                {ws.name}
              </option>
            ))}
          </select>
          {onCreateWorkspace && (
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Create workspace"
              title="Create workspace"
              onClick={() => {
                const name = window.prompt('New workspace name:');
                if (name?.trim()) onCreateWorkspace(name.trim());
              }}
            >
              +
            </button>
          )}
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Rooms</span>
          <div className={styles.sectionActions}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onOpenBrowseRooms}
              title="Browse public rooms"
            >
              Browse
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onOpenCreateRoom}
              aria-label="Create room"
              title="Create room"
            >
              +
            </button>
          </div>
        </div>

        {channelRooms.length === 0 ? (
          <p className={styles.empty}>No rooms yet</p>
        ) : (
          <ul className={styles.list}>
            {channelRooms.map((room) => {
              const unread = unreadByRoom[room._id] || 0;
              const isActive = room._id === activeRoomId;
              return (
                <li key={room._id}>
                  <button
                    type="button"
                    className={`${styles.item} ${isActive ? styles.active : ''}`}
                    onClick={() => handleSelect(room._id)}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <span className={styles.roomIcon} aria-hidden="true">
                      {room.type === 'private' ? '🔒' : '#'}
                    </span>
                    <div className={styles.itemBody}>
                      <div className={styles.itemTop}>
                        <span className={styles.name}>{room.name}</span>
                        {unread > 0 && (
                          <span
                            className={styles.badge}
                            aria-label={`${unread} unread messages`}
                          >
                            {unread > 99 ? '99+' : unread}
                          </span>
                        )}
                      </div>
                      {room.lastMessage && (
                        <p className={styles.preview}>
                          {room.lastMessage.senderName}:{' '}
                          {room.lastMessage.deletedAt
                            ? 'This message was deleted'
                            : room.lastMessage.text}
                        </p>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Direct messages</span>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onOpenNewDm}
            aria-label="New direct message"
            title="New direct message"
          >
            +
          </button>
        </div>

        {dmRooms.length === 0 ? (
          <p className={styles.empty}>No direct messages yet</p>
        ) : (
          <ul className={styles.list}>
            {dmRooms.map((room) => {
              const unread = unreadByRoom[room._id] || 0;
              const isActive = room._id === activeRoomId;
              const partnerId = room.otherUser?.id;
              const isOnline = partnerId ? onlineUserIds.has(partnerId) : false;
              return (
                <li key={room._id}>
                  <button
                    type="button"
                    className={`${styles.item} ${isActive ? styles.active : ''}`}
                    onClick={() => handleSelect(room._id)}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <span
                      className={`${styles.presenceDot} ${isOnline ? styles.online : styles.offline}`}
                      aria-hidden="true"
                    />
                    <div className={styles.itemBody}>
                      <div className={styles.itemTop}>
                        <span className={styles.name}>{room.otherUser?.username || room.name}</span>
                        {unread > 0 && (
                          <span
                            className={styles.badge}
                            aria-label={`${unread} unread messages`}
                          >
                            {unread > 99 ? '99+' : unread}
                          </span>
                        )}
                      </div>
                      {room.lastMessage && (
                        <p className={styles.preview}>
                          {room.lastMessage.senderName}:{' '}
                          {room.lastMessage.deletedAt
                            ? 'This message was deleted'
                            : room.lastMessage.text}
                        </p>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}
