import styles from './OnlineUsers.module.css';

export default function OnlineUsers({ users, currentUserId, isOpen, onClose }) {
  return (
    <aside
      className={`${styles.sidebar} ${isOpen ? styles.open : ''}`}
      aria-label="Online users"
    >
      <div className={styles.header}>
        <h2 className={styles.heading}>Online ({users.length})</h2>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close online users"
        >
          ×
        </button>
      </div>

      {users.length === 0 ? (
        <p className={styles.empty}>No other users online</p>
      ) : (
        <ul className={styles.list}>
          {users.map((u) => {
            const isSelf = u.userId === currentUserId;
            return (
              <li key={u.userId} className={styles.item}>
                <span className={styles.statusDot} aria-hidden="true" />
                <span className={styles.username}>{u.username}</span>
                {isSelf && <span className={styles.youTag}>you</span>}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
