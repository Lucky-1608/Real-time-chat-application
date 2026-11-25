import styles from './MessageItem.module.css';

function formatTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function MessageItem({ message, isOwn, isGrouped, onRetry }) {
  const { _id, senderName, text, createdAt, status, error, readBy = [] } = message;

  // Exclude self from readBy count when computing "Seen by N"
  const otherReadersCount = readBy.filter((id) => id !== message.sender).length;

  return (
    <div
      className={`${styles.row} ${isOwn ? styles.ownRow : styles.otherRow} ${
        isGrouped ? styles.grouped : styles.firstInGroup
      }`}
    >
      {!isOwn && !isGrouped && <span className={styles.sender}>{senderName}</span>}

      <div className={`${styles.bubble} ${isOwn ? styles.ownBubble : styles.otherBubble}`}>
        <p className={styles.text}>{text}</p>
        <div className={styles.meta}>
          <time className={styles.time} dateTime={createdAt}>
            {formatTime(createdAt)}
          </time>

          {isOwn && status === 'sending' && <span className={styles.status}>Sending…</span>}

          {isOwn && status === 'sent' && (
            <span className={styles.status}>
              {otherReadersCount > 0 ? `Seen by ${otherReadersCount}` : 'Sent'}
            </span>
          )}
        </div>
      </div>

      {isOwn && status === 'failed' && (
        <div className={styles.failedRow} role="alert">
          <span className={styles.failedText}>{error || 'Failed to send'}</span>
          <button type="button" className={styles.retryBtn} onClick={() => onRetry(_id)}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
