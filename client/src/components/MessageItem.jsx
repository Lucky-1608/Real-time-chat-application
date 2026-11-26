import { useState } from 'react';
import styles from './MessageItem.module.css';

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '🙏'];

function formatTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function MessageItem({
  message,
  currentUserId,
  isOwn,
  isRoomOwner = false,
  isGrouped,
  userDirectory = {},
  onRetry,
  onEdit,
  onDelete,
  onToggleReaction,
  itemRef,
}) {
  const [showReaders, setShowReaders] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editError, setEditError] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const {
    _id,
    room,
    senderName,
    text,
    createdAt,
    editedAt,
    deletedAt,
    status,
    error,
    readBy = [],
    reactions = [],
  } = message;

  const isDeleted = Boolean(deletedAt);
  const isConfirmed = status !== 'sending' && status !== 'failed';
  const withinEditWindow =
    createdAt && Date.now() - new Date(createdAt).getTime() <= EDIT_WINDOW_MS;
  const canEdit = isOwn && !isDeleted && isConfirmed && withinEditWindow;
  const canDelete = (isOwn || isRoomOwner) && !isDeleted && isConfirmed;

  // Exclude sender from readBy when computing "Seen by N"
  const otherReaderIds = readBy.filter((id) => id !== message.sender);
  const readerNames = otherReaderIds.map((id) => userDirectory[id] || 'User');

  function startEdit() {
    setEditText(text);
    setEditError('');
    setIsEditing(true);
    setConfirmDelete(false);
  }

  async function saveEdit() {
    const trimmed = editText.trim();
    if (!trimmed) {
      setEditError('Message cannot be empty');
      return;
    }
    if (trimmed === text) {
      setIsEditing(false);
      return;
    }

    setSavingEdit(true);
    setEditError('');
    try {
      await onEdit?.(room, _id, trimmed);
      setIsEditing(false);
    } catch (err) {
      setEditError(err.message || 'Failed to edit');
    } finally {
      setSavingEdit(false);
    }
  }

  function handleEditKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsEditing(false);
      setEditError('');
    }
  }

  async function handleConfirmDelete() {
    try {
      await onDelete?.(room, _id);
      setConfirmDelete(false);
    } catch {
      setConfirmDelete(false);
    }
  }

  return (
    <div
      ref={itemRef}
      data-message-id={_id}
      className={`${styles.row} ${isOwn ? styles.ownRow : styles.otherRow} ${
        isGrouped ? styles.grouped : styles.firstInGroup
      }`}
    >
      {!isOwn && !isGrouped && <span className={styles.sender}>{senderName}</span>}

      <div className={styles.bubbleWrap}>
        {!isDeleted && isConfirmed && !isEditing && (
          <div className={styles.actions}>
            <div className={styles.reactionPicker} role="group" aria-label="Add reaction">
              {ALLOWED_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className={styles.emojiPickBtn}
                  onClick={() => onToggleReaction?.(room, _id, emoji)}
                  aria-label={`React with ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
            {canEdit && (
              <button type="button" className={styles.actionBtn} onClick={startEdit}>
                Edit
              </button>
            )}
            {canDelete && !confirmDelete && (
              <button
                type="button"
                className={`${styles.actionBtn} ${styles.deleteAction}`}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            )}
          </div>
        )}

        <div
          className={`${styles.bubble} ${isOwn ? styles.ownBubble : styles.otherBubble} ${
            isDeleted ? styles.deletedBubble : ''
          }`}
        >
          {isDeleted ? (
            <p className={styles.tombstone}>This message was deleted</p>
          ) : isEditing ? (
            <div className={styles.editBox}>
              <textarea
                className={styles.editInput}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={handleEditKeyDown}
                maxLength={2000}
                rows={2}
                autoFocus
                disabled={savingEdit}
                aria-label="Edit message"
              />
              {editError && <span className={styles.editError}>{editError}</span>}
              <div className={styles.editControls}>
                <button
                  type="button"
                  className={styles.saveBtn}
                  onClick={saveEdit}
                  disabled={savingEdit}
                >
                  {savingEdit ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className={styles.cancelBtn}
                  onClick={() => setIsEditing(false)}
                  disabled={savingEdit}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className={styles.text}>{text}</p>
          )}

          <div className={styles.meta}>
            {editedAt && !isDeleted && <span className={styles.editedTag}>(edited)</span>}
            <time className={styles.time} dateTime={createdAt}>
              {formatTime(createdAt)}
            </time>

            {isOwn && status === 'sending' && <span className={styles.status}>Sending…</span>}

            {isOwn && !isDeleted && status === 'sent' && otherReaderIds.length === 0 && (
              <span className={styles.status}>Sent</span>
            )}

            {isOwn && !isDeleted && status === 'sent' && otherReaderIds.length > 0 && (
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
      </div>

      {!isDeleted && reactions.length > 0 && (
        <div className={styles.reactionsBar}>
          {reactions.map((r) => {
            const reactedByMe = r.users.includes(currentUserId);
            const names = r.users.map((id) => userDirectory[id] || 'User').join(', ');
            return (
              <button
                key={r.emoji}
                type="button"
                className={`${styles.reactionPill} ${reactedByMe ? styles.reactionMine : ''}`}
                title={`${r.emoji} — ${names}`}
                aria-label={`${r.emoji} ${r.users.length} — ${names}`}
                aria-pressed={reactedByMe}
                onClick={() => onToggleReaction?.(room, _id, r.emoji)}
              >
                <span>{r.emoji}</span>
                <span className={styles.reactionCount}>{r.users.length}</span>
              </button>
            );
          })}
        </div>
      )}

      {confirmDelete && (
        <div className={styles.confirmRow} role="alert">
          <span>Delete message?</span>
          <button type="button" className={styles.confirmYes} onClick={handleConfirmDelete}>
            Confirm
          </button>
          <button
            type="button"
            className={styles.confirmNo}
            onClick={() => setConfirmDelete(false)}
          >
            Cancel
          </button>
        </div>
      )}

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
