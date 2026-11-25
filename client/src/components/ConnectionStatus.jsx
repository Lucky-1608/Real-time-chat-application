import styles from './ConnectionStatus.module.css';

const STATUS_CONFIG = {
  connecting: {
    label: 'Connecting to chat server…',
    tone: 'warning',
  },
  reconnecting: {
    label: 'Connection lost. Reconnecting…',
    tone: 'warning',
  },
  disconnected: {
    label: 'Disconnected from chat server.',
    tone: 'danger',
  },
};

export default function ConnectionStatus({ status }) {
  if (status === 'connected') return null;

  const config = STATUS_CONFIG[status] || STATUS_CONFIG.connecting;

  return (
    <div
      className={`${styles.banner} ${styles[config.tone]}`}
      role="status"
      aria-live="polite"
    >
      <span className={styles.dot} aria-hidden="true" />
      <span>{config.label}</span>
    </div>
  );
}
