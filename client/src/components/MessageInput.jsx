import { useState } from 'react';
import styles from './MessageInput.module.css';

const MAX_LENGTH = 2000;

export default function MessageInput({ onSend, onTyping, onStopTyping, disabled }) {
  const [text, setText] = useState('');

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onStopTyping();
    onSend(trimmed);
    setText('');
  }

  function handleSubmit(e) {
    e.preventDefault();
    submit();
  }

  function handleChange(e) {
    const next = e.target.value;
    setText(next);
    if (next.trim().length > 0) {
      onTyping();
    } else {
      onStopTyping();
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <label htmlFor="message-composer" className={styles.srOnly}>
        Type a message
      </label>
      <textarea
        id="message-composer"
        className={styles.textarea}
        rows={1}
        maxLength={MAX_LENGTH}
        placeholder="Message #global (Enter to send, Shift+Enter for newline)"
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={onStopTyping}
        disabled={disabled}
      />
      <button
        type="submit"
        className={styles.sendBtn}
        disabled={disabled || text.trim().length === 0}
      >
        Send
      </button>
    </form>
  );
}
