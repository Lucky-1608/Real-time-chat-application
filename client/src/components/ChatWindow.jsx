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
import AdminDashboardModal from './AdminDashboardModal.jsx';
import OnboardingTour from './OnboardingTour.jsx';
import WebhooksModal from './WebhooksModal.jsx';
import styles from './ChatWindow.module.css';

export default function ChatWindow() {
  const { user, logout } = useAuth();
  const [roomsDrawerOpen, setRoomsDrawerOpen] = useState(false);
  const [usersDrawerOpen, setUsersDrawerOpen] = useState(false);
  const [activeModal, setActiveModal] = useState(null);

  const {
    workspaces,
    activeWorkspace,
    switchWorkspace,
    createWorkspace,
    onboarding,
    tourOpen,
    demoLoading,
    setTourStep,
    completeTour,
    skipTour,
    reopenTour,
    addDemoContent,
    removeDemoContent,
    availableCommands,
    ephemeralMessages,
    dismissEphemeral,
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
    setNotificationLevel,
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
          workspaces={workspaces}
          activeWorkspace={activeWorkspace}
          onSwitchWorkspace={switchWorkspace}
          onCreateWorkspace={createWorkspace}
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
            onSetNotificationLevel={setNotificationLevel}
            onStartDm={startDm}
            onSummarize={() => requestSummary(activeRoomId)}
            summaryLoading={summaryLoading}
            onOpenSecurity={() => setActiveModal('security-settings')}
            onOpenAdmin={() => setActiveModal('admin-dashboard')}
            onOpenTour={reopenTour}
            onOpenWebhooks={() => setActiveModal('webhooks')}
            onLogout={logout}
          />

          {activeRoom?.disappearingTtlSeconds > 0 && (
            <div
              role="status"
              style={{
                padding: '0.35rem 1rem',
                fontSize: '0.8rem',
                background: 'rgba(245, 158, 11, 0.14)',
                borderBottom: '1px solid rgba(245, 158, 11, 0.3)',
                textAlign: 'center',
              }}
            >
              Disappearing messages are enabled: new messages expire after{' '}
              {activeRoom.disappearingTtlSeconds === 3600
                ? '1 hour'
                : activeRoom.disappearingTtlSeconds === 86400
                  ? '24 hours'
                  : '7 days'}
              .
            </div>
          )}

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
              ephemeralMessages={ephemeralMessages}
              onDismissEphemeral={dismissEphemeral}
              onPickGif={(url) => sendMessage(url)}
            />
            <TypingIndicator typingUsers={typingUsers} />
            <MessageInput
              roomId={activeRoomId}
              onSend={sendMessage}
              onTyping={notifyTyping}
              onStopTyping={stopTyping}
              disabled={!activeRoomId}
              roomLabel={roomLabel}
              availableCommands={availableCommands}
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
      <WebhooksModal
        isOpen={activeModal === 'webhooks'}
        onClose={() => setActiveModal(null)}
        room={activeRoom}
      />
      <OnboardingTour
        isOpen={tourOpen}
        onboarding={onboarding}
        hasDemoRoom={rooms.some((r) => r.name?.toLowerCase() === 'demo-playground')}
        demoLoading={demoLoading}
        onStepChange={setTourStep}
        onComplete={completeTour}
        onSkip={skipTour}
        onOpenCreateRoom={() => setActiveModal('create-room')}
        onAddDemoContent={addDemoContent}
        onRemoveDemoContent={removeDemoContent}
      />
      <AdminDashboardModal
        isOpen={activeModal === 'admin-dashboard'}
        onClose={() => setActiveModal(null)}
      />
    </div>
  );
}
