import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useChat } from '../hooks/useChat.js';
import { useTypingIndicator } from '../hooks/useTypingIndicator.js';
import ConnectionStatus from './ConnectionStatus.jsx';
import MessageList from './MessageList.jsx';
import TypingIndicator from './TypingIndicator.jsx';
import MessageInput from './MessageInput.jsx';
import OnlineUsers from './OnlineUsers.jsx';
import styles from './ChatWindow.module.css';

export default function ChatWindow() {
  const { user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const {
    messages,
    hasMore,
    loadingHistory,
    loadingOlder,
    historyError,
    connectionStatus,
    onlineUsers,
    typingUsers,
    loadOlderMessages,
    sendMessage,
    retryMessage,
    emitTypingStart,
    emitTypingStop,
  } = useChat();

  const { notifyTyping, stopTyping } = useTypingIndicator(emitTypingStart, emitTypingStop);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.roomInfo}>
          <span className={styles.hash} aria-hidden="true">
            #
          </span>
          <div>
            <h1 className={styles.roomName}>global</h1>
            <p className={styles.roomMeta}>Signed in as {user?.username}</p>
          </div>
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.usersToggle}
            onClick={() => setSidebarOpen((prev) => !prev)}
            aria-expanded={sidebarOpen}
          >
            Online ({onlineUsers.length})
          </button>
          <button type="button" className={styles.logoutBtn} onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <ConnectionStatus status={connectionStatus} />

      <div className={styles.body}>
        <main className={styles.chatMain}>
          <MessageList
            messages={messages}
            currentUserId={user?.id}
            hasMore={hasMore}
            loadingHistory={loadingHistory}
            loadingOlder={loadingOlder}
            historyError={historyError}
            onLoadOlder={loadOlderMessages}
            onRetry={retryMessage}
          />
          <TypingIndicator typingUsers={typingUsers} />
          <MessageInput
            onSend={sendMessage}
            onTyping={notifyTyping}
            onStopTyping={stopTyping}
            disabled={false}
          />
        </main>

        <OnlineUsers
          users={onlineUsers}
          currentUserId={user?.id}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        {sidebarOpen && (
          <div
            className={styles.backdrop}
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}
