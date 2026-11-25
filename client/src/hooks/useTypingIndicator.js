import { useCallback, useEffect, useRef } from 'react';

const TYPING_THROTTLE_MS = 1000;
const TYPING_IDLE_TIMEOUT_MS = 1500;

export function useTypingIndicator(emitTypingStart, emitTypingStop) {
  const lastStartSentRef = useRef(0);
  const idleTimerRef = useRef(null);
  const isTypingRef = useRef(false);

  const stopTyping = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (isTypingRef.current) {
      isTypingRef.current = false;
      emitTypingStop();
    }
  }, [emitTypingStop]);

  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (!isTypingRef.current || now - lastStartSentRef.current >= TYPING_THROTTLE_MS) {
      isTypingRef.current = true;
      lastStartSentRef.current = now;
      emitTypingStart();
    }

    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = setTimeout(() => {
      stopTyping();
    }, TYPING_IDLE_TIMEOUT_MS);
  }, [emitTypingStart, stopTyping]);

  useEffect(() => {
    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }
    };
  }, []);

  return { notifyTyping, stopTyping };
}
