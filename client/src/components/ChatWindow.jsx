import { useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useChat } from '../hooks/useChat.js';
import { useTypingIndicator } from '../hooks/useTypingIndicator.js';
import ConnectionStatus from './ConnectionStatus.jsx';
import RoomSidebar from './RoomSidebar.jsx';
import RoomHeader from './RoomHeader.jsx';
import MessageList from './MessageList.jsx';
import TypingIndicator from './TypingIndicator.jsx';
import MessageInput from './MessageInput.jsx';
import OnlineUsers from './OnlineUsers.jsx';
import CreateRoomModal from './CreateRoomModal.jsx';
import NewDMModal from './NewDMModal.jsx';
import BrowseRoomsModal from './BrowseRoomsModal.jsx';
import InviteMembersModal from './InviteMembersModal.jsx';
import SecuritySettingsModal from './SecuritySettingsModal.jsx';
import styles from './ChatWindow.module.css';

export default function ChatWindow() {
  const { user, logout } = useAuth();
  const [roomsDrawerOpen, setRoomsDrawerOpen] = useState(false);
  const [usersDrawerOpen, setUsersDrawerOpen] = useState(false);
  const [activeModal, setActiveModal] = useState(null);

  const {
    rooms,
    activeRoomId,
    activeRoom,
    selectRoom,
    messages,
    hasMore,
    loadingHistory,
    loadingOlder,
    historyError,
    typingUsers,
    unreadByRoom,
    summary,
    summaryLoading,
    summaryError,
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
    requestSummary,
    dismissSummary,
  } = useChat();

  const { notifyTyping, stopTyping } = useTypingIndicator(emitTypingStart, emitTypingStop);

  const onlineUserIds = useMemo(
    () => new Set(onlineUsers.map((u) => u.userId)),
    [onlineUsers]
  );

  function handleSelectRoom(roomId) {
    stopTyping();
    selectRoom(roomId);
  }

  const roomLabel = activeRoom
    ? activeRoom.type === 'dm'
      ? `@${activeRoom.otherUser?.username || activeRoom.name}`
      : `#${activeRoom.name}`
    : '#General';

  const isRoomOwner = Boolean(
    activeRoom?.members?.some(
      (m) => m.user?.id === user?.id && ['owner', 'admin', 'moderator'].includes(m.role)
    )
  );

  const anyDrawerOpen = roomsDrawerOpen || usersDrawerOpen;

  return (
    <div className={styles.shell}>
      <ConnectionStatus status={connectionStatus} />

      <div className={styles.workspace}>
        <RoomSidebar
          rooms={rooms}
          activeRoomId={activeRoomId}
          unreadByRoom={unreadByRoom}
          onlineUserIds={onlineUserIds}
          isOpen={roomsDrawerOpen}
          onClose={() => setRoomsDrawerOpen(false)}
          onSelectRoom={handleSelectRoom}
          onOpenCreateRoom={() => setActiveModal('create-room')}
          onOpenBrowseRooms={() => setActiveModal('browse-rooms')}
          onOpenNewDm={() => setActiveModal('new-dm')}
        />

        <div className={styles.center}>
          <RoomHeader
            room={activeRoom}
            currentUser={user}
            onlineUserIds={onlineUserIds}
            onlineCount={onlineUsers.length}
            onOpenRoomsDrawer={() => setRoomsDrawerOpen(true)}
            onOpenUsersDrawer={() => setUsersDrawerOpen(true)}
            onInviteClick={() => setActiveModal('invite-members')}
            onLeaveRoom={leaveRoom}
            onDeleteRoom={deleteRoom}
            onChangeMemberRole={changeMemberRole}
            onRemoveMember={removeMember}
            onStartDm={startDm}
            onSummarize={() => requestSummary(activeRoomId)}
            summaryLoading={summaryLoading}
            onOpenSecurity={() => setActiveModal('security-settings')}
            onLogout={logout}
          />

          <main className={styles.chatMain}>
            <MessageList
              roomId={activeRoomId}
              messages={messages}
              currentUserId={user?.id}
              isRoomOwner={isRoomOwner}
              userDirectory={userDirectory}
              hasMore={hasMore}
              loadingHistory={loadingHistory}
              loadingOlder={loadingOlder}
              historyError={historyError}
              unreadCount={unreadByRoom[activeRoomId] || 0}
              summary={summary}
              summaryLoading={summaryLoading}
              summaryError={summaryError}
              onRequestSummary={(force) => requestSummary(activeRoomId, { force })}
              onDismissSummary={() => dismissSummary(activeRoomId)}
              onLoadOlder={loadOlderMessages}
              onRetry={retryMessage}
              onEdit={editMessage}
              onDelete={deleteMessage}
              onToggleReaction={toggleReaction}
              onMarkRead={markMessagesRead}
            />
            <TypingIndicator typingUsers={typingUsers} />
            <MessageInput
              roomId={activeRoomId}
              onSend={sendMessage}
              onTyping={notifyTyping}
              onStopTyping={stopTyping}
              disabled={!activeRoomId}
              roomLabel={roomLabel}
            />
          </main>
        </div>

        <OnlineUsers
          users={onlineUsers}
          currentUserId={user?.id}
          isOpen={usersDrawerOpen}
          onClose={() => setUsersDrawerOpen(false)}
          onStartDm={startDm}
        />

        {anyDrawerOpen && (
          <div
            className={styles.backdrop}
            onClick={() => {
              setRoomsDrawerOpen(false);
              setUsersDrawerOpen(false);
            }}
            aria-hidden="true"
          />
        )}
      </div>

      <CreateRoomModal
        isOpen={activeModal === 'create-room'}
        onClose={() => setActiveModal(null)}
        onCreateRoom={createRoom}
      />
      <NewDMModal
        isOpen={activeModal === 'new-dm'}
        onClose={() => setActiveModal(null)}
        onStartDm={startDm}
      />
      <BrowseRoomsModal
        isOpen={activeModal === 'browse-rooms'}
        onClose={() => setActiveModal(null)}
        onJoinRoom={joinPublicRoom}
      />
      <InviteMembersModal
        isOpen={activeModal === 'invite-members'}
        onClose={() => setActiveModal(null)}
        room={activeRoom}
        onInvite={inviteMembers}
      />
      <SecuritySettingsModal
        isOpen={activeModal === 'security-settings'}
        onClose={() => setActiveModal(null)}
      />
    </div>
  );
}
