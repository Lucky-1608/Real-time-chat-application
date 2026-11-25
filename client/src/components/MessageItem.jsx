import { useState } from 'react';
import styles from './MessageItem.module.css';

function formatTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function MessageItem({
  message,
  isOwn,
  isGrouped,
  userDirectory = {},
  onRetry,
  itemRef,
}) {
  const [showReaders, setShowReaders] = useState(false);
  const { _id, senderName, text, createdAt, status, error, readBy = [] } = message;

  // Exclude sender from readBy when computing "Seen by N"
  const otherReaderIds = readBy.filter((id) => id !== message.sender);
  const readerNames = otherReaderIds.map((id) => userDirectory[id] || 'User');

  return (
    <div
      ref={itemRef}
      data-message-id={_id}
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

          {isOwn && status === 'sent' && otherReaderIds.length === 0 && (
            <span className={styles.status}>Sent</span>
          )}

          {isOwn && status === 'sent' && otherReaderIds.length > 0 && (
            <button
              type="button"
              className={styles.seenBtn}
              title={`Seen by ${readerNames.join(', ')}`}
              onClick={() => setShowReaders((prev) => !prev)}
            >
              Seen by {otherReaderIds.length}
            </button>
          )}
        </div>
      </div>

      {isOwn && showReaders && readerNames.length > 0 && (
        <div className={styles.readersList}>Seen by {readerNames.join(', ')}</div>
      )}

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
