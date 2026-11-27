import { useState } from 'react';
import RichMessageText from './RichMessageText.jsx';
import styles from './MessageItem.module.css';

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '🙏'];

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  const [lightboxUrl, setLightboxUrl] = useState(null);

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
    attachments = [],
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
      {!isOwn && !isGrouped && (
        <span className={styles.sender}>
          {senderName}
          {message.isBot && (
            <span
              style={{
                marginLeft: '0.35rem',
                padding: '0.05rem 0.3rem',
                fontSize: '0.65rem',
                fontWeight: 700,
                borderRadius: '4px',
                background: '#0369a1',
                color: '#ffffff',
                verticalAlign: 'middle',
              }}
            >
              BOT
            </span>
          )}
        </span>
      )}

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
            <>
              {text && <div className={styles.text}><RichMessageText text={text} /></div>}
              {attachments.length > 0 && (
                <div className={styles.attachments}>
                  {attachments.map((att) => {
                    const status = att.scanStatus || 'clean';
                    if (status === 'pending') {
                      return (
                        <div key={att.key} className={styles.fileChipPending}>
                          <span className={styles.fileChipName}>{att.name}</span>
                          <span className={styles.fileChipSize}>
                            Scanning… ({formatFileSize(att.size)})
                          </span>
                        </div>
                      );
                    }
                    if (status === 'rejected') {
                      return (
                        <div key={att.key} className={styles.fileChipRejected}>
                          <span className={styles.fileChipName}>{att.name}</span>
                          <span className={styles.fileChipSize}>
                            Blocked: {att.scanReason || 'Unsafe file'}
                          </span>
                        </div>
                      );
                    }
                    const src = att.url || att.previewUrl;
                    const isImage = att.contentType?.startsWith('image/');
                    if (isImage && src) {
                      return (
                        <button
                          key={att.key}
                          type="button"
                          className={styles.imageBtn}
                          onClick={() => setLightboxUrl(src)}
                          aria-label={`View image ${att.name}`}
                        >
                          <img
                            src={src}
                            alt={att.name}
                            loading="lazy"
                            className={styles.attachmentImage}
                          />
                        </button>
                      );
                    }
                    return (
                      <a
                        key={att.key}
                        href={src || '#'}
                        download={att.name}
                        target="_blank"
                        rel="noreferrer"
                        className={styles.fileChip}
                      >
                        <span className={styles.fileChipName}>{att.name}</span>
                        <span className={styles.fileChipSize}>{formatFileSize(att.size)}</span>
                      </a>
                    );
                  })}
                </div>
              )}
            </>
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

      {lightboxUrl && (
        <div
          className={styles.lightbox}
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onClick={() => setLightboxUrl(null)}
        >
          <img src={lightboxUrl} alt="Full size preview" className={styles.lightboxImg} />
        </div>
      )}
    </div>
  );
}
