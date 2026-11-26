import { useState } from 'react';
import styles from './RoomHeader.module.css';

export default function RoomHeader({
  room,
  currentUser,
  onlineUserIds,
  onlineCount,
  onOpenRoomsDrawer,
  onOpenUsersDrawer,
  onInviteClick,
  onLeaveRoom,
  onDeleteRoom,
  onStartDm,
  onSummarize,
  summaryLoading = false,
  onOpenSecurity,
  onLogout,
}) {
  const [membersOpen, setMembersOpen] = useState(false);

  const isDm = room?.type === 'dm';
  const partnerOnline = isDm && room?.otherUser?.id && onlineUserIds.has(room.otherUser.id);
  const myMember = room?.members?.find((m) => m.user?.id === currentUser?.id);
  const isOwner = myMember?.role === 'owner';
  const isGeneral = room?.type === 'public' && room?.name?.toLowerCase() === 'general';

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <button
          type="button"
          className={styles.mobileBtn}
          onClick={onOpenRoomsDrawer}
          aria-label="Open rooms navigation"
        >
          ☰
        </button>

        <div className={styles.roomInfo}>
          <span className={styles.icon} aria-hidden="true">
            {isDm ? '@' : room?.type === 'private' ? '🔒' : '#'}
          </span>
          <div>
            <h1 className={styles.title}>{room ? room.name : 'PulseChat'}</h1>
            <p className={styles.meta}>
              {isDm ? (
                <span>{partnerOnline ? 'Online' : 'Offline'}</span>
              ) : room ? (
                <button
                  type="button"
                  className={styles.membersBtn}
                  onClick={() => setMembersOpen((prev) => !prev)}
                  aria-expanded={membersOpen}
                >
                  {room.members?.length || 0} members
                </button>
              ) : (
                <span>Signed in as {currentUser?.username}</span>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className={styles.actions}>
        {room && (
          <button
            type="button"
            className={styles.actionBtn}
            onClick={onSummarize}
            disabled={summaryLoading}
            title="Summarize unread or recent messages"
          >
            {summaryLoading ? 'Summarizing…' : 'Catch me up'}
          </button>
        )}

        {room?.type === 'private' && isOwner && (
          <button type="button" className={styles.actionBtn} onClick={onInviteClick}>
            Invite
          </button>
        )}

        {room && !isDm && !isOwner && !isGeneral && (
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => onLeaveRoom(room._id)}
          >
            Leave
          </button>
        )}

        {room && !isDm && isOwner && !isGeneral && (
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.dangerBtn}`}
            onClick={() => onDeleteRoom(room._id)}
          >
            Delete
          </button>
        )}

        <button
          type="button"
          className={styles.mobileBtn}
          onClick={onOpenUsersDrawer}
          aria-label="Open online users"
        >
          Online ({onlineCount})
        </button>

        <button
          type="button"
          className={styles.actionBtn}
          onClick={onOpenSecurity}
          title="Manage active sessions"
        >
          Security
        </button>

        <button type="button" className={styles.logoutBtn} onClick={onLogout}>
          Sign out
        </button>
      </div>

      {membersOpen && room && !isDm && (
        <div className={styles.membersPopover} role="region" aria-label="Room members">
          <div className={styles.popoverHeader}>
            <span>Members ({room.members?.length || 0})</span>
            <button
              type="button"
              className={styles.closePopover}
              onClick={() => setMembersOpen(false)}
              aria-label="Close members list"
            >
              ×
            </button>
          </div>
          <ul className={styles.memberList}>
            {(room.members || []).map((m) => {
              const id = m.user?.id;
              const name = m.user?.username || 'User';
              const isOnline = id ? onlineUserIds.has(id) : false;
              const isSelf = id === currentUser?.id;
              return (
                <li key={id} className={styles.memberItem}>
                  <span
                    className={`${styles.dot} ${isOnline ? styles.online : styles.offline}`}
                    aria-hidden="true"
                  />
                  <span className={styles.memberName}>
                    {name}
                    {m.role === 'owner' ? ' (owner)' : ''}
                  </span>
                  {!isSelf && id && (
                    <button
                      type="button"
                      className={styles.dmQuickBtn}
                      onClick={() => {
                        setMembersOpen(false);
                        onStartDm(id);
                      }}
                    >
                      Message
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </header>
  );
}
