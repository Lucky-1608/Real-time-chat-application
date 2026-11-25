import { useAutoScroll } from '../hooks/useAutoScroll.js';
import MessageItem from './MessageItem.jsx';
import styles from './MessageList.module.css';

const GROUP_WINDOW_MS = 5 * 60 * 1000;

function isConsecutiveMessage(prev, curr) {
  if (!prev || prev.sender !== curr.sender) return false;
  const delta = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return delta >= 0 && delta <= GROUP_WINDOW_MS;
}

export default function MessageList({
  messages,
  currentUserId,
  hasMore,
  loadingHistory,
  loadingOlder,
  historyError,
  onLoadOlder,
  onRetry,
}) {
  const {
    containerRef,
    hasNewMessages,
    handleScroll,
    scrollToBottom,
    captureScrollForPrepend,
  } = useAutoScroll(messages, currentUserId);

  function handleLoadOlderClick() {
    captureScrollForPrepend();
    onLoadOlder();
  }

  return (
    <div className={styles.wrapper}>
      <div
        ref={containerRef}
        className={styles.list}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Chat messages"
      >
        {hasMore && (
          <div className={styles.loadOlderWrap}>
            <button
              type="button"
              className={styles.loadOlderBtn}
              onClick={handleLoadOlderClick}
              disabled={loadingOlder}
            >
              {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
            </button>
          </div>
        )}

        {historyError && (
          <div className={styles.errorBanner} role="alert">
            {historyError}
          </div>
        )}

        {loadingHistory ? (
          <p className={styles.emptyState}>Loading messages…</p>
        ) : messages.length === 0 ? (
          <p className={styles.emptyState}>No messages yet. Say hello!</p>
        ) : (
          messages.map((msg, idx) => {
            const prev = idx > 0 ? messages[idx - 1] : null;
            return (
              <MessageItem
                key={msg._id}
                message={msg}
                isOwn={msg.sender === currentUserId}
                isGrouped={isConsecutiveMessage(prev, msg)}
                onRetry={onRetry}
              />
            );
          })
        )}
      </div>

      {hasNewMessages && (
        <button
          type="button"
          className={styles.newMessagesBtn}
          onClick={() => scrollToBottom('smooth')}
        >
          New messages ↓
        </button>
      )}
    </div>
  );
}
