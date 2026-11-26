import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client.js';
import Modal from './Modal.jsx';
import styles from './RoomModals.module.css';

export default function NewDMModal({ isOpen, onClose, onStartDm }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setUsers([]);
      setError('');
      return undefined;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await apiFetch(`/api/users?q=${encodeURIComponent(query.trim())}`);
        setUsers(data.users || []);
      } catch (err) {
        setError(err.message || 'Failed to search users');
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [isOpen, query]);

  async function handlePick(userId) {
    setError('');
    try {
      await onStartDm(userId);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to start direct message');
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New direct message">
      <div className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="dm-user-search" className={styles.label}>
            Find a user
          </label>
          <input
            id="dm-user-search"
            className={styles.input}
            placeholder="Search by username…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <p className={styles.empty}>Searching…</p>
        ) : users.length === 0 ? (
          <p className={styles.empty}>No users found</p>
        ) : (
          <ul className={styles.resultsList}>
            {users.map((u) => (
              <li key={u.id} className={styles.resultItem}>
                <span>{u.username}</span>
                <button type="button" className={styles.smallBtn} onClick={() => handlePick(u.id)}>
                  Message
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
