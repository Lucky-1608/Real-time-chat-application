import styles from './TypingIndicator.module.css';

function formatTypingText(users) {
  if (users.length === 0) return '';
  if (users.length === 1) return `${users[0].username} is typing…`;
  if (users.length === 2) return `${users[0].username} and ${users[1].username} are typing…`;
  return 'Several people are typing…';
}

export default function TypingIndicator({ typingUsers }) {
  const text = formatTypingText(typingUsers);

  return (
    <div className={styles.container} aria-live="polite">
      {text ? <span className={styles.text}>{text}</span> : null}
    </div>
  );
}
