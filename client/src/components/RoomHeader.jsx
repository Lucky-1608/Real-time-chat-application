import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage, formatLocalizedNumber } from '../i18n.js';
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
  onChangeMemberRole,
  onRemoveMember,
  onSetNotificationLevel,
  onStartDm,
  onSummarize,
  summaryLoading = false,
  onOpenSecurity,
  onOpenAdmin,
  onLogout,
}) {
  const { t, i18n } = useTranslation();
  const [membersOpen, setMembersOpen] = useState(false);

  const isDm = room?.type === 'dm';
  const partnerOnline = isDm && room?.otherUser?.id && onlineUserIds.has(room.otherUser.id);
  const myMember = room?.members?.find((m) => m.user?.id === currentUser?.id);
  const myRole = myMember?.role || 'member';
  const isOwner = myRole === 'owner';
  const canInvite = ['owner', 'admin', 'moderator'].includes(myRole);
  const canManageRoles = ['owner', 'admin'].includes(myRole);
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
                  {t('membersCount', { count: formatLocalizedNumber(room.members?.length || 0, i18n.language) })}
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
          <select
            aria-label="Room notification level"
            className={styles.actionBtn}
            value={myMember?.notificationLevel || (myMember?.muted ? 'muted' : 'all')}
            onChange={(e) => onSetNotificationLevel?.(room._id, e.target.value)}
            title="Notification preference"
          >
            <option value="all">Notify: All</option>
            <option value="mentions">Notify: @Mentions</option>
            <option value="muted">Notify: Muted</option>
          </select>
        )}

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

        {room?.type === 'private' && canInvite && (
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

        <select
          aria-label={t('language')}
          className={styles.actionBtn}
          value={i18n.language}
          onChange={(e) => changeLanguage(e.target.value)}
        >
          <option value="en">EN</option>
          <option value="hi">HI</option>
          <option value="pseudo">PSEUDO</option>
        </select>

        <button
          type="button"
          className={styles.actionBtn}
          onClick={onOpenSecurity}
          title="Manage active sessions"
        >
          {t('security')}
        </button>

        {currentUser?.globalRole === 'admin' && (
          <button
            type="button"
            className={styles.actionBtn}
            onClick={onOpenAdmin}
            title="Admin Dashboard"
          >
            {t('admin')}
          </button>
        )}

        <button type="button" className={styles.logoutBtn} onClick={onLogout}>
          {t('signOut')}
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
                    {m.role && m.role !== 'member' ? ` (${m.role})` : ''}
                  </span>
                  {!isSelf && id && canManageRoles && m.role !== 'owner' && (isOwner || m.role !== 'admin') && (
                    <>
                      <select
                        aria-label={`Change role for ${name}`}
                        value={m.role || 'member'}
                        onChange={(e) => onChangeMemberRole?.(room._id, id, e.target.value)}
                        className={styles.dmQuickBtn}
                      >
                        <option value="member">member</option>
                        <option value="moderator">moderator</option>
                        {isOwner && <option value="admin">admin</option>}
                        {isOwner && <option value="owner">owner (transfer)</option>}
                      </select>
                      <button
                        type="button"
                        className={styles.dmQuickBtn}
                        onClick={() => onRemoveMember?.(room._id, id)}
                      >
                        Kick
                      </button>
                    </>
                  )}
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
