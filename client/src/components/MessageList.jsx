import { useCallback, useEffect, useRef } from 'react';
import { useAutoScroll } from '../hooks/useAutoScroll.js';
import MessageItem from './MessageItem.jsx';
import styles from './MessageList.module.css';

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const MONGO_ID_REGEX = /^[0-9a-fA-F]{24}$/;

function isConsecutiveMessage(prev, curr) {
  if (!prev || prev.sender !== curr.sender) return false;
  const delta = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return delta >= 0 && delta <= GROUP_WINDOW_MS;
}

export default function MessageList({
  roomId,
  messages,
  currentUserId,
  isRoomOwner,
  userDirectory,
  hasMore,
  loadingHistory,
  loadingOlder,
  historyError,
  unreadCount = 0,
  summary,
  summaryLoading = false,
  summaryError,
  onRequestSummary,
  onDismissSummary,
  onLoadOlder,
  onRetry,
  onEdit,
  onDelete,
  onToggleReaction,
  onMarkRead,
  ephemeralMessages = [],
  onDismissEphemeral,
  onPickGif,
}) {
  const {
    containerRef,
    hasNewMessages,
    handleScroll,
    scrollToBottom,
    captureScrollForPrepend,
  } = useAutoScroll(messages, currentUserId);

  const itemElementsRef = useRef(new Map());
  const visibleUnreadIdsRef = useRef(new Set());
  const reportedReadIdsRef = useRef(new Set());
  const flushTimerRef = useRef(null);

  const flushVisibleReads = useCallback(() => {
    if (
      document.visibilityState !== 'visible' ||
      !document.hasFocus() ||
      visibleUnreadIdsRef.current.size === 0
    ) {
      return;
    }

    const toReport = [];
    for (const id of visibleUnreadIdsRef.current) {
      if (!reportedReadIdsRef.current.has(id)) {
        toReport.push(id);
        reportedReadIdsRef.current.add(id);
      }
    }
    visibleUnreadIdsRef.current.clear();

    if (toReport.length > 0 && roomId && typeof onMarkRead === 'function') {
      onMarkRead(roomId, toReport);
    }
  }, [roomId, onMarkRead]);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(flushVisibleReads, 100);
  }, [flushVisibleReads]);

  useEffect(() => {
    visibleUnreadIdsRef.current.clear();
  }, [roomId]);

  // Observe visible unread messages from other users and emit read receipts when focused.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !roomId || typeof IntersectionObserver === 'undefined') return;

    const unreadById = new Map();
    for (const m of messages) {
      const isUnreadOther =
        m.sender !== currentUserId &&
        MONGO_ID_REGEX.test(m._id) &&
        !(m.readBy || []).includes(currentUserId) &&
        !reportedReadIdsRef.current.has(m._id);
      if (isUnreadOther) {
        unreadById.set(m._id, true);
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute('data-message-id');
          if (!id || !unreadById.has(id)) continue;
          if (entry.isIntersecting) {
            visibleUnreadIdsRef.current.add(id);
          } else {
            visibleUnreadIdsRef.current.delete(id);
          }
        }
        scheduleFlush();
      },
      { root, threshold: 0.5 }
    );

    for (const [id, el] of itemElementsRef.current.entries()) {
      if (el && unreadById.has(id)) {
        observer.observe(el);
      }
    }

    const handleFocusOrVisibility = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        flushVisibleReads();
      }
    };

    window.addEventListener('focus', handleFocusOrVisibility);
    document.addEventListener('visibilitychange', handleFocusOrVisibility);

    return () => {
      observer.disconnect();
      window.removeEventListener('focus', handleFocusOrVisibility);
      document.removeEventListener('visibilitychange', handleFocusOrVisibility);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, [roomId, messages, currentUserId, containerRef, scheduleFlush, flushVisibleReads]);

  const setItemRef = useCallback((id, el) => {
    if (el) {
      itemElementsRef.current.set(id, el);
    } else {
      itemElementsRef.current.delete(id);
    }
  }, []);

  function handleLoadOlderClick() {
    captureScrollForPrepend();
    onLoadOlder();
  }

  return (
    <div className={styles.wrapper}>
      {unreadCount >= 10 && !summary && !summaryLoading && (
        <div className={styles.catchUpBanner}>
          <span>{unreadCount} unread messages in this room</span>
          <button type="button" className={styles.catchUpBtn} onClick={() => onRequestSummary?.(false)}>
            Catch me up
          </button>
        </div>
      )}

      {(summaryLoading || summary || summaryError) && (
        <section className={styles.summaryCard} aria-live="polite" aria-label="AI room summary">
          {summaryLoading ? (
            <div className={styles.skeletonWrap} aria-busy="true">
              <div className={styles.skeletonLine} />
              <div className={styles.skeletonLineShort} />
            </div>
          ) : summaryError ? (
            <div className={styles.summaryErrorRow}>
              <span>{summaryError}</span>
              <button
                type="button"
                className={styles.summaryActionBtn}
                onClick={() => onDismissSummary?.()}
              >
                Dismiss
              </button>
            </div>
          ) : (
            <>
              <div className={styles.summaryHeader}>
                <span className={styles.summaryLabel}>
                  Generated by AI from {summary.messageCount} messages · Summaries may be imperfect
                </span>
                <div className={styles.summaryBtns}>
                  <button
                    type="button"
                    className={styles.summaryActionBtn}
                    onClick={() => onRequestSummary?.(true)}
                  >
                    Regenerate
                  </button>
                  <button
                    type="button"
                    className={styles.summaryActionBtn}
                    onClick={() => onDismissSummary?.()}
                    aria-label="Dismiss summary"
                  >
                    ×
                  </button>
                </div>
              </div>
              <p className={styles.summaryText}>{summary.summary}</p>
            </>
          )}
        </section>
      )}

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
                currentUserId={currentUserId}
                isOwn={msg.sender === currentUserId}
                isRoomOwner={isRoomOwner}
                isGrouped={isConsecutiveMessage(prev, msg)}
                userDirectory={userDirectory}
                onRetry={onRetry}
                onEdit={onEdit}
                onDelete={onDelete}
                onToggleReaction={onToggleReaction}
                itemRef={(el) => setItemRef(msg._id, el)}
              />
            );
          })
        )}

        {ephemeralMessages.map((eph) => (
          <div
            key={eph.id}
            role="status"
            style={{
              margin: '0.5rem 0',
              padding: '0.65rem 0.85rem',
              borderRadius: '8px',
              background: eph.isError ? 'rgba(153, 27, 27, 0.25)' : 'rgba(15, 23, 42, 0.85)',
              border: '1px solid #334155',
              color: '#f8fafc',
              fontSize: '0.85rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
              <span style={{ fontSize: '0.72rem', color: '#7dd3fc', fontWeight: 600 }}>
                Only visible to you (ephemeral)
              </span>
              {onDismissEphemeral && (
                <button
                  type="button"
                  onClick={() => onDismissEphemeral(eph.id)}
                  aria-label="Dismiss ephemeral message"
                  style={{
                    background: 'transparent',
                    color: '#cbd5e1',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              )}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{eph.text}</div>
            {Array.isArray(eph.candidates) && eph.candidates.length > 0 && (
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                {eph.candidates.map((gif) => (
                  <button
                    key={gif.id}
                    type="button"
                    onClick={() => {
                      onPickGif?.(gif.url);
                      onDismissEphemeral?.(eph.id);
                    }}
                    style={{
                      padding: 0,
                      border: '1px solid #475569',
                      borderRadius: '6px',
                      overflow: 'hidden',
                      cursor: 'pointer',
                      background: '#0f172a',
                    }}
                  >
                    <img
                      src={gif.previewUrl}
                      alt={gif.title}
                      style={{ display: 'block', height: '80px', width: 'auto' }}
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
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
