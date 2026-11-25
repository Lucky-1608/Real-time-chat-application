import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const NEAR_BOTTOM_THRESHOLD_PX = 100;

export function useAutoScroll(messages, currentUserId) {
  const containerRef = useRef(null);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const isNearBottomRef = useRef(true);
  const prevLengthRef = useRef(0);
  const pendingScrollRestoreRef = useRef(null);

  const checkIfNearBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_THRESHOLD_PX;
  }, []);

  const handleScroll = useCallback(() => {
    const nearBottom = checkIfNearBottom();
    isNearBottomRef.current = nearBottom;
    if (nearBottom) {
      setHasNewMessages(false);
    }
  }, [checkIfNearBottom]);

  const scrollToBottom = useCallback((behavior = 'smooth') => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    isNearBottomRef.current = true;
    setHasNewMessages(false);
  }, []);

  /**
   * Captures scrollHeight before older messages are prepended so we can
   * restore the exact visual scroll offset after React commits the DOM update.
   */
  const captureScrollForPrepend = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    pendingScrollRestoreRef.current = {
      prevScrollHeight: el.scrollHeight,
      prevScrollTop: el.scrollTop,
    };
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    const restore = pendingScrollRestoreRef.current;
    if (el && restore) {
      const delta = el.scrollHeight - restore.prevScrollHeight;
      el.scrollTop = restore.prevScrollTop + delta;
      pendingScrollRestoreRef.current = null;
    }
  }, [messages]);

  useEffect(() => {
    const prevLen = prevLengthRef.current;
    const nextLen = messages.length;
    prevLengthRef.current = nextLen;

    if (nextLen === 0 || nextLen <= prevLen) return;

    // Initial load: jump immediately to the bottom.
    if (prevLen === 0) {
      scrollToBottom('auto');
      return;
    }

    // If older messages were prepended (pendingScrollRestoreRef handled in useLayoutEffect), skip auto-scroll.
    if (pendingScrollRestoreRef.current) return;

    const latest = messages[nextLen - 1];
    const isOwnMessage = latest?.sender === currentUserId;

    if (isNearBottomRef.current || isOwnMessage) {
      scrollToBottom('smooth');
    } else {
      setHasNewMessages(true);
    }
  }, [messages, currentUserId, scrollToBottom]);

  return {
    containerRef,
    hasNewMessages,
    handleScroll,
    scrollToBottom,
    captureScrollForPrepend,
  };
}
